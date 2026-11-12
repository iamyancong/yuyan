import type { DeployErrorSummary, DeployLogItem, DeployRecord } from '@/api/deploy';
import { formatDeployDateTime } from '../../constant.ts';
import { diagnoseBuildFailure } from '../../buildFailureDiagnosis.ts';
import { filterAttentionLogs, isToolLog, presentDeployLogMessage, shouldHideLevelTag } from '../../logPresentation.ts';

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

/** ANSI 转义序列（CSI 颜色 / 光标控制 + OSC 超链接 / 标题） */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** 除换行 / 制表 / 回车外的其他不可见控制字符（含残留的孤立 ESC） */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * 去除终端颜色控制码（兼容旧版本后端已落库的 `ESC[36m` 等原始输出）。
 * @param text 原始文本
 * @returns 纯文本
 */
export function stripAnsi(text: string): string {
  return String(text ?? '')
    .replace(ANSI_PATTERN, '')
    .replace(CONTROL_CHAR_PATTERN, '');
}

/**
 * 清洗单条日志消息（特别是兼容旧后端将整坨 stderr 拼在同一 message 里的历史记录）
 * @param rawMessage 原始消息字符串
 * @returns 清洗后的消息字符串
 */
export function cleanLogMessage(rawMessage: string): string {
  if (!rawMessage) return rawMessage;
  rawMessage = stripAnsi(rawMessage);
  if (!rawMessage.includes('\n')) return rawMessage;

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
 * @param showHints 是否在行尾追加白话提示
 * @param context 是否为失败上下文保护保留的行（以 ┆ 代替 │）
 * @returns 适合 Monaco 展示的日志文本（工具输出以 │ 缩进并隐藏 info 标签）
 */
export const formatLogItem = (item: DeployLogItem, showHints = false, context = false) => {
  const level = shouldHideLevelTag(item) ? ''.padEnd(7, ' ') : item.level.toUpperCase().padEnd(7, ' ');
  const stage = item.stage && !isToolLog(item) ? `[${item.stage}] ` : '';
  const message = presentDeployLogMessage(item, cleanLogMessage(item.message), showHints, context);
  return `${formatDeployDateTime(item.timestamp)} ${level} ${stage}${message}`;
};

/** 发布日志展示文本 */
export interface RecordLogView {
  /** Monaco 展示文本（不含诊断报告） */
  text: string;
  /** 实际展示的日志条数 */
  count: number;
  /** 失败上下文行的行号（1 开始，用于 Monaco 弱化装饰） */
  contextLineNumbers: number[];
}

/**
 * 按过滤模式生成发布日志展示文本。
 * 「仅错误与告警」模式带失败上下文保护：工具 error 行之后同一段工具输出保留到下一条雨燕系统日志为止（#46）。
 * @param logs 日志列表
 * @param filterMode 过滤模式
 * @param showHints 是否在行尾追加白话提示
 * @returns 展示文本与失败上下文行号
 */
export function buildRecordLogView(logs: DeployLogItem[], filterMode: LogFilterMode, showHints = false): RecordLogView {
  const entries = filterMode === 'errors' ? filterAttentionLogs(logs) : logs.map((item) => ({ item, context: false }));
  const lines: string[] = [];
  const contextLineNumbers: number[] = [];
  for (const { item, context } of entries) {
    const text = formatLogItem(item, showHints, context);
    const lineCount = text.split('\n').length;
    if (context) {
      for (let offset = 1; offset <= lineCount; offset++) contextLineNumbers.push(lines.length + offset);
    }
    lines.push(...text.split('\n'));
  }
  return { text: lines.join('\n'), count: entries.length, contextLineNumbers };
}

/** 诊断报告标题（定位按钮据此查找报告所在行） */
export const DIAGNOSTIC_BANNER_TITLE = '雨燕构建未通过诊断报告 (BUILD DIAGNOSTIC)';

/**
 * 格式化退出码 / 退出信号。
 * @param exitCode 退出码或信号名
 * @returns 展示文案
 */
function formatExitCode(exitCode: number | string): string {
  return typeof exitCode === 'number' || /^-?\d+$/.test(String(exitCode)) ? `退出码: ${exitCode}` : `退出信号: ${exitCode}`;
}

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
    `[ERROR] 🚨 ${DIAGNOSTIC_BANNER_TITLE}`,
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
  if (summary.failedCommand) {
    lines.push(`[INFO]  失败命令: ${summary.failedCommand}`);
  }
  if (summary.failedStep) {
    const skipped = summary.skippedSteps?.length ? `（后续 ${summary.skippedSteps.join('、')} 未执行）` : '';
    lines.push(`[ERROR] 失败步骤: ${summary.failedStep}${skipped}`);
  }
  if (summary.exitCode !== undefined && summary.exitCode !== null && summary.exitCode !== '') {
    lines.push(`[INFO]  ${formatExitCode(summary.exitCode)}`);
  }
  if (summary.otherErrorCount) {
    lines.push(`[WARN]  另有 ${summary.otherErrorCount} 处报错，修复上面这条后请一并查看上方日志`);
  }

  if (summary.suggestion) {
    lines.push(thinLine);
    lines.push('[INFO]  💡 排查与修复建议:');
    const sugLines = summary.suggestion.split(/\r?\n/);
    for (const sl of sugLines) {
      if (sl.trim()) lines.push(`[INFO]  ▸ ${sl.trim()}`);
    }
  }

  const excerpt = summary.excerpt || summary.rawDetail;
  if (excerpt) {
    lines.push(thinLine);
    if (summary.excerpt) {
      // 原始输出保留缩进（放在前缀之后，行首仍顶格），与本地执行构建命令看到的一致
      lines.push('[ERROR] 📋 原始报错输出（与本地执行构建命令看到的一致）:');
      for (const rl of summary.excerpt.split(/\r?\n/)) {
        lines.push(`[ERROR] │ ${rl.replace(/\s+$/, '')}`);
      }
      if (summary.excerptOmittedLines) {
        lines.push(`[INFO]  … 其余 ${summary.excerptOmittedLines} 行见上方日志`);
      }
    } else {
      lines.push('[ERROR] 📋 核心错误堆栈:');
      const rawLines = excerpt.split(/\r?\n/).slice(0, 8);
      for (const rl of rawLines) {
        if (rl.trim()) lines.push(`[ERROR] ▸ ${rl.trim()}`);
      }
    }
  }

  lines.push(line);
  lines.push('');
  return lines.join('\n');
}

/**
 * 查找日志文本中诊断报告标题所在行（1 开始）。
 * @param content 编辑器内容
 * @returns 行号；未找到返回 0
 */
export function findDiagnosticBannerLine(content: string): number {
  const text = String(content ?? '');
  const index = text.lastIndexOf(DIAGNOSTIC_BANNER_TITLE);
  if (index < 0) return 0;
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * 从发布日志与发布记录中提取错误根因诊断信息（#58：按真实报错归因，见 buildFailureDiagnosis.ts）
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
  return diagnoseBuildFailure(logs, { record });
}
