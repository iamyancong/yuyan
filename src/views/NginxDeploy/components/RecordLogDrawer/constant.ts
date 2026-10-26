import type { DeployErrorSummary, DeployLogItem, DeployRecord } from '@/api/deploy';
import { formatDeployDateTime } from '../../constant.ts';

/** 记录摘要项 */
export interface RecordSummaryItem {
  label: string;
  value: string;
  link?: string;
}

/** 日志过滤模式 */
export type LogFilterMode = 'all' | 'errors';

/**
 * 格式化空值展示。
 * @param value 原始值
 * @returns 展示文案
 */
export const formatEmptyText = (value?: string | number | null) => {
  const text = String(value ?? '').trim();
  return text || '-';
};

/**
 * 获取发布状态文案。
 * @param status 发布状态
 * @returns 状态文案
 */
export const getStatusLabel = (status?: DeployRecord['status']) => {
  const statusMap: Record<DeployRecord['status'], string> = {
    running: '执行中',
    success: '成功',
    failed: '失败',
    stopped: '已停止',
  };
  return status ? statusMap[status] : '-';
};

/**
 * 清洗单条日志消息（特别是兼容旧后端将整坨 stderr 拼在同一 message 里的历史记录）
 * @param rawMessage 原始消息字符串
 * @returns 清洗后的消息字符串
 */
export function cleanLogMessage(rawMessage: string): string {
  if (!rawMessage || !rawMessage.includes('\n')) return rawMessage;

  // 如果包含 "构建产物 执行失败，退出码" 说明是旧后端序列化的全量 stderr 堆叠
  if (/构建产物\s*执行失败/i.test(rawMessage)) {
    const lines = rawMessage.split(/\r?\n/);
    const cleanedLines: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      // 过滤掉旧日志中由 stderr 一并 dump 下来的启动/分包无关警告
      if (line.includes('Module level directives cause errors when bundled') && line.includes('was ignored')) {
        continue;
      }
      if (line.startsWith('<script') && line.includes("can't be bundled")) continue;
      if (line.startsWith('(!) Some chunks are larger than')) continue;
      if (
        line.startsWith('- Using dynamic import()') ||
        line.startsWith('- Use build.rollupOptions') ||
        line.startsWith('- Adjust chunk size')
      ) {
        continue;
      }
      if (
        line.startsWith('file:///data/') &&
        line.includes('check-build-bundle.mjs') &&
        lines[i + 1]?.includes('throw new Error')
      ) {
        continue;
      }
      if (line.includes('throw new Error(`首屏静态依赖') || line === '^') continue;
      cleanedLines.push(lines[i]);
    }
    return cleanedLines.join('\n');
  }

  return rawMessage;
}

/**
 * 格式化单条发布日志
 * @param item 发布日志项
 * @returns 适合 Monaco 展示的日志文本
 */
export const formatLogItem = (item: DeployLogItem) => {
  const level = item.level.toUpperCase().padEnd(7, ' ');
  const stage = item.stage ? `[${item.stage}] ` : '';
  const message = cleanLogMessage(item.message);
  return `${formatDeployDateTime(item.timestamp)} ${level} ${stage}${message}`;
};

/**
 * 格式化在 Monaco 编辑器内部展示的终端高亮诊断报告（全行顶格，避免触发 Monaco 缩进参考竖线与代码折叠箭头）
 * @param summary 错误根因诊断信息
 * @returns 终端 ASCII 风格报告文本（采用 log 语法高亮格式）
 */
export function formatEditorDiagnosticBanner(summary: DeployErrorSummary): string {
  const line = '═'.repeat(78);
  const thinLine = '─'.repeat(78);
  const lines: string[] = [
    '',
    line,
    '[ERROR] 🚨 雨燕构建未通过诊断报告 (BUILD DIAGNOSTIC)',
    line,
    `[ERROR] 拦截阶段: ${summary.stage || '构建执行'}`,
    `[ERROR] 错误类型: ${summary.category || '构建异常'}${summary.title ? ` - ${summary.title}` : ''}`,
  ];

  if (summary.violation) {
    lines.push(`[ERROR] 触发违规: ${summary.violation}`);
  }
  if (summary.fileLocation) {
    lines.push(`[INFO]  相关位置: ${summary.fileLocation}`);
  }

  if (summary.suggestion) {
    lines.push(thinLine);
    lines.push('[INFO]  💡 排查与修复建议:');
    const sugLines = summary.suggestion.split(/\r?\n/);
    for (const sl of sugLines) {
      if (sl.trim()) lines.push(`[INFO]  ▸ ${sl.trim()}`);
    }
  }

  if (summary.rawDetail) {
    lines.push(thinLine);
    lines.push('[ERROR] 📋 核心错误堆栈:');
    const rawLines = summary.rawDetail.split(/\r?\n/).slice(0, 8);
    for (const rl of rawLines) {
      if (rl.trim()) lines.push(`[ERROR] ▸ ${rl.trim()}`);
    }
  }

  lines.push(line);
  lines.push('');
  return lines.join('\n');
}

/**
 * 从发布日志与发布记录中提取错误根因诊断信息
 * @param logs 日志列表
 * @param record 发布记录
 * @returns 错误根因诊断
 */
export function extractErrorSummaryFromLogs(
  logs: DeployLogItem[] = [],
  record?: DeployRecord | null
): DeployErrorSummary | null {
  // 如果已有记录中的 summary 且不包含未插值的模板字符串，则直接复用
  if (
    record?.errorSummary &&
    !record.errorSummary.title?.includes('${violations') &&
    !record.errorSummary.title?.includes('join(')
  ) {
    return record.errorSummary;
  }
  if (!logs?.length) return null;

  // 将日志展开为按行计数的列表，确保行号精准对应 Monaco 界面行号
  const flattened: { lineIndex: number; clean: string; raw: string }[] = [];
  let lineCounter = 1;
  for (const item of logs) {
    const lines = String(item.message || '').split(/\r?\n/);
    for (const sub of lines) {
      const trimmed = sub.trim();
      const clean = trimmed
        .replace(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+[A-Z]+\s+(?:\[[^\]]+\]\s+)?/, '')
        .trim();
      flattened.push({
        lineIndex: lineCounter,
        clean,
        raw: trimmed,
      });
      lineCounter++;
    }
  }

  // 1. 首屏重型依赖门禁拦截（如 check-build-bundle.mjs）
  for (let i = 0; i < flattened.length; i++) {
    const { clean, lineIndex } = flattened[i];
    if (!clean || /^\s*at\s+/.test(clean) || clean === '^') continue;
    if (/^throw\s+new\s+Error/i.test(clean) || clean.includes('${violations') || clean.includes('violations.join')) continue;

    if (/首屏静态依赖包含重型运行时依赖/i.test(clean)) {
      const match = clean.match(/首屏静态依赖包含重型运行时依赖[:：]?\s*(.*)/);
      let violation = match && match[1] && !match[1].includes('${') ? match[1].trim() : '';
      if (!violation) {
        const assetMatch = clean.match(/assets\/[^\s"')]+/);
        if (assetMatch) violation = assetMatch[0];
      }

      let fileLocation = '';
      for (let j = Math.max(0, i - 5); j <= i; j++) {
        const loc = flattened[j].clean.match(/(?:scripts\/[^\s:]+:\d+)/);
        if (loc) {
          fileLocation = loc[0];
          break;
        }
      }

      const stack: string[] = [clean];
      for (let j = i + 1; j < Math.min(flattened.length, i + 6); j++) {
        if (/^\s*at\s+/.test(flattened[j].clean)) {
          stack.push(flattened[j].clean);
        } else {
          break;
        }
      }

      return {
        stage: 'check-build-bundle',
        category: '工程门禁拦截',
        title: '首屏静态依赖包含重型运行时依赖',
        violation: violation || clean.replace(/^Error:\s*/i, ''),
        fileLocation: fileLocation || 'scripts/check-build-bundle.mjs:286',
        suggestion: '检测到首屏静态资源包含了未按需拆分的重型库（如 Monaco、ECharts、Sheet 等）。请检查 main.ts、App.vue 或路由顶层，避免全局静态 import，改为按需或 defineAsyncComponent 异步加载。',
        rawDetail: stack.join('\n'),
        lineIndex,
      };
    }
  }

  // 2. 依赖解析失败（如用户图一中的 @vue-office/excel）
  for (let i = 0; i < flattened.length; i++) {
    const { clean, lineIndex } = flattened[i];
    if (/Failed to resolve entry for package\s+"([^"]+)"/i.test(clean)) {
      const pkg = clean.match(/Failed to resolve entry for package\s+"([^"]+)"/i)?.[1] || '';
      return {
        stage: 'build',
        category: '依赖解析失败',
        title: '未能正确解析依赖包入口',
        violation: pkg,
        fileLocation: 'package.json',
        suggestion: `未能在项目中正确解析依赖包 "${pkg}"。请检查 package.json 是否声明了该依赖，或在部署配置中勾选“本次重新安装依赖”。`,
        rawDetail: clean,
        lineIndex,
      };
    }
    if (/Failed to resolve import\s+"([^"]+)"/i.test(clean) || /Cannot find module\s+'([^']+)'/i.test(clean)) {
      const mod =
        clean.match(/Failed to resolve import\s+"([^"]+)"/i)?.[1] ||
        clean.match(/Cannot find module\s+'([^']+)'/i)?.[1] ||
        '';
      return {
        stage: 'build',
        category: '模块导入失败',
        title: '找不到目标模块或路径错误',
        violation: mod,
        suggestion: `找不到路径 "${mod}"。请检查路径拼写、后缀或对应文件是否存在。`,
        rawDetail: clean,
        lineIndex,
      };
    }
  }

  // 3. 页面预算超标（check-page-budget.mjs）
  for (let i = 0; i < flattened.length; i++) {
    const { clean, lineIndex } = flattened[i];
    if (/check-page-budget/i.test(clean) || /页面预算超出/i.test(clean) || /page budget exceeded/i.test(clean)) {
      return {
        stage: 'check-page-budget',
        category: '性能预算门禁',
        title: '首屏页面打包体积超出预设上限',
        violation: clean,
        suggestion: '首屏静态分包体积超出配置阈值，请使用 dynamic import() 拆分组件或优化 manualChunks。',
        rawDetail: clean,
        lineIndex,
      };
    }
  }

  // 4. Node.js 内存溢出 (OOM)
  for (let i = 0; i < flattened.length; i++) {
    const { clean, lineIndex } = flattened[i];
    if (/JavaScript heap out of memory/i.test(clean)) {
      return {
        stage: 'build',
        category: '构建内存溢出',
        title: 'Node.js 堆内存耗尽 (OOM)',
        suggestion: '打包构建消耗内存超出上限，可在构建命令前加入 NODE_OPTIONS="--max-old-space-size=4096"。',
        rawDetail: clean,
        lineIndex,
      };
    }
  }

  // 5. TypeScript 类型校验失败
  for (let i = 0; i < flattened.length; i++) {
    const { clean, lineIndex } = flattened[i];
    if (/error TS\d+:\s*(.*)/i.test(clean)) {
      const match = clean.match(/error TS\d+:\s*(.*)/);
      return {
        stage: 'type-check',
        category: 'TypeScript 类型错误',
        title: 'TypeScript 类型校验未通过',
        violation: match ? match[1] : clean,
        suggestion: '请修复上述 TypeScript 类型校验错误后重新提交代码发布。',
        rawDetail: clean,
        lineIndex,
      };
    }
  }

  // 6. 兜底通用 Error（从后往前找最接近退出的错误）
  for (let i = flattened.length - 1; i >= 0; i--) {
    const { clean, lineIndex } = flattened[i];
    if (/^(?:Error|TypeError|SyntaxError|ReferenceError):\s*(.+)/i.test(clean)) {
      const match = clean.match(/^(?:Error|TypeError|SyntaxError|ReferenceError):\s*(.+)/i);
      const title = match ? match[1].trim() : clean;
      if (!title.includes('Command failed with exit code')) {
        return {
          stage: 'build',
          category: '异常抛错',
          title,
          violation: title,
          suggestion: '代码或构建脚本执行抛出未处理异常，请查看下方堆栈排查。',
          rawDetail: clean,
          lineIndex,
        };
      }
    }
  }

  // 若发布状态为失败，提供兜底
  if (record?.status === 'failed') {
    return {
      stage: 'build',
      category: '执行失败',
      title: '构建产物或发布流程执行失败，退出码非 0',
      suggestion: '命令执行以非 0 状态码退出，请查看下方控制台日志排查。',
      detail: logs.slice(-5).map((l) => l.message).join('\n'),
      lineIndex: logs.length,
    };
  }

  return null;
}
