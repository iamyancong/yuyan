/**
 * 发布日志「说人话」展示层
 * @description 不改变日志行数（保证错误诊断定位行号准确），只做三件事：
 * 1. 区分来源：工具原始输出（git / pnpm / vite / maven）以 `│` 缩进并隐藏 info 级别标签，视觉上降级为「附录」；
 * 2. 白话提示：对高频但费解的输出在行尾追加 `💡 一句话解释`；
 * 3. 级别图例：统一 info / success / warn / error 的用户语义；
 * 4. 失败上下文保护（#46）：「仅错误与告警」模式下，工具 error 行之后同一段工具输出一直保留到下一条雨燕系统日志，
 *    保证 `file:` 定位行与堆栈不被过滤，并以 `┆` 弱化标出。
 */
import type { DeployLogItem } from '@/api/deploy';

/** 工具输出行前缀（缩进 + 竖线，表示归属上一条雨燕系统说明） */
export const TOOL_LOG_PREFIX = '│ ';

/** 失败上下文行前缀（虚线竖线，表示该行因失败上下文保护而保留，本身不是错误或告警） */
export const TOOL_CONTEXT_LOG_PREFIX = '┆ ';

/** 失败上下文行在 Monaco 中的弱化样式类名（全局样式见 RecordLogDrawer/style.less） */
export const DEPLOY_LOG_CONTEXT_LINE_CLASS = 'deploy-log-context-line';

/** 白话提示前缀 */
export const LOG_HINT_PREFIX = '  💡 ';

/** 白话提示规则 */
export interface DeployLogHintRule {
  /** 匹配规则（作用于去除 ANSI 后的单行消息） */
  pattern: RegExp;
  /** 白话提示；函数形式可引用捕获组 */
  hint: string | ((match: RegExpMatchArray) => string);
}

/**
 * 白话提示规则表（按顺序匹配，命中第一条即停止）。
 * 只收录「高频 + 费解」的输出，避免每行都挂提示造成新的噪音。
 */
export const DEPLOY_LOG_HINT_RULES: DeployLogHintRule[] = [
  // ---------- Git ----------
  { pattern: /^From\s+\S+/, hint: 'Git 正在从代码仓库拉取最新代码' },
  { pattern: /^\*\s+branch\s+(\S+)\s+->\s+FETCH_HEAD/, hint: (m) => `已获取远端 ${m[1]} 分支的最新提交` },
  {
    pattern: /^\+\s*[0-9a-f]{6,}\.{2,3}[0-9a-f]{6,}\s+(\S+)\s+->\s+\S+\s+\(forced update\)/,
    hint: (m) => `远端 ${m[1]} 分支被强制更新（force push），已同步到最新提交，请确认部署的提交符合预期`,
  },
  {
    pattern: /^[0-9a-f]{6,}\.{2}[0-9a-f]{6,}\s+(\S+)\s+->\s+\S+/,
    hint: (m) => `本地 ${m[1]} 分支已更新到远端最新提交`,
  },
  { pattern: /^\*\s+\[new branch\]/, hint: '发现远端新分支' },
  { pattern: /^Already up[ -]to[ -]date/i, hint: '代码已是最新，无需更新' },
  { pattern: /^HEAD is now at ([0-9a-f]{6,})/, hint: (m) => `工作区已切换到提交 ${m[1].slice(0, 8)}` },
  { pattern: /^Cloning into/, hint: '首次克隆代码仓库，耗时会比后续发布更长' },
  // ---------- npm scripts ----------
  {
    pattern: /^>\s+(\S+)@[\w.-]+\s+([\w:.-]+)\s/,
    hint: (m) => `开始执行 ${m[1]} 的 package.json 脚本「${m[2]}」`,
  },
  { pattern: /^>\s+\S/, hint: '该脚本实际执行的命令' },
  // ---------- Vite ----------
  { pattern: /^vite v[\d.]+\S*\s+building/i, hint: '开始生产环境打包' },
  { pattern: /^transforming/i, hint: '正在编译源码模块，项目越大耗时越久' },
  { pattern: /^✓\s*(\d+)\s+modules? transformed/i, hint: (m) => `源码编译完成，共 ${m[1]} 个模块` },
  { pattern: /^rendering chunks/i, hint: '正在生成打包文件' },
  { pattern: /^computing gzip size/i, hint: '正在统计压缩后体积' },
  { pattern: /^✓\s*built in\s+([\d.]+\s*m?s)/i, hint: (m) => `打包完成，耗时 ${m[1]}` },
  { pattern: /^\(!\)\s*Some chunks are larger than/i, hint: '部分打包文件体积较大，不影响发布，可后续拆包优化' },
  { pattern: /can't be bundled without type="module"/i, hint: '该脚本未参与打包、按原样输出，通常不影响发布' },
  { pattern: /Module level directives cause errors when bundled/i, hint: '第三方库的 "use client" 指令被忽略，不影响发布' },
  // ---------- pnpm / npm ----------
  { pattern: /\bWARN\b.*\bdeprecated\b/i, hint: '依赖包已被作者标记为废弃，不影响本次发布' },
  { pattern: /unmet peer|peer dependenc/i, hint: '依赖版本声明不完全匹配，通常不影响构建' },
  { pattern: /^Lockfile is up to date/i, hint: '依赖锁文件一致，按锁定版本安装' },
  { pattern: /^Progress: resolved/i, hint: '依赖安装进度' },
  { pattern: /^Done in\s+([\d.]+\s*m?s)/i, hint: (m) => `执行完成，耗时 ${m[1]}` },
  { pattern: /ELIFECYCLE.*Command failed/i, hint: '构建脚本异常退出，请向上查找第一条红色错误' },
  { pattern: /ERR_PNPM_(\w+)/, hint: (m) => `pnpm 执行出错（${m[1]}），请结合上下文排查` },
  { pattern: /JavaScript heap out of memory/i, hint: '构建内存不足：系统会自动按更大内存重试；如果仍然失败，请调高目标的「最低构建内存」' },
  // ---------- Maven / Gradle ----------
  { pattern: /^\[INFO\] BUILD SUCCESS/, hint: 'Java 构建成功' },
  { pattern: /^\[INFO\] BUILD FAILURE/, hint: 'Java 构建失败，请向上查找 [ERROR] 行' },
  { pattern: /^Downloading from|^Downloaded from/, hint: '正在下载 Maven 依赖，首次构建较慢' },
  // ---------- 雨燕系统说明中的术语 ----------
  { pattern: /^已注入运行时 npm 私服配置/, hint: '临时写入公司 npm 源地址与凭据，仅本次安装使用，结束后自动清理' },
  { pattern: /^依赖缓存命中/, hint: '依赖与上次一致，直接复用已安装结果，节省时间' },
  { pattern: /^构建内存预算池已预占/, hint: '为本次构建预留的内存，避免多个项目同时构建时互相挤占' },
  { pattern: /SSH 用户不可写.*sudo/, hint: '部署目录权限不足，已自动改用 sudo 上传，无需处理' },
];

/**
 * 根据单行消息解析白话提示。
 * @param message 已去除 ANSI 的日志消息
 * @param rules 规则表，默认 {@link DEPLOY_LOG_HINT_RULES}
 * @returns 白话提示；未命中或多行消息时返回空字符串
 */
export function resolveDeployLogHint(message: string, rules: DeployLogHintRule[] = DEPLOY_LOG_HINT_RULES): string {
  const text = String(message || '').trim();
  if (!text || text.includes('\n')) return '';
  for (const rule of rules) {
    const match = text.match(rule.pattern);
    if (match) return typeof rule.hint === 'function' ? rule.hint(match) : rule.hint;
  }
  return '';
}

/**
 * 是否为工具原始输出。
 * @param item 日志项（缺省 source 视为雨燕系统说明）
 */
export function isToolLog(item: Pick<DeployLogItem, 'source'>): boolean {
  return item.source === 'tool';
}

/**
 * 工具输出的 info 行隐藏级别标签（保留 warn / error / success，便于高亮与过滤）。
 * @param item 日志项
 */
export function shouldHideLevelTag(item: Pick<DeployLogItem, 'level' | 'source'>): boolean {
  return isToolLog(item) && item.level === 'info';
}

/**
 * 生成日志正文：工具输出加 `│` 缩进前缀（失败上下文行为 `┆`），按需在行尾追加白话提示。
 * 不会新增换行，保证 Monaco 行号与错误诊断定位一致。
 * @param item 日志项
 * @param cleanedMessage 已清洗（去 ANSI / 去噪）的消息
 * @param showHints 是否展示白话提示
 * @param context 是否为失败上下文保护保留的行
 * @returns 日志正文
 */
export function presentDeployLogMessage(
  item: Pick<DeployLogItem, 'source'>,
  cleanedMessage: string,
  showHints: boolean,
  context = false
): string {
  const hint = showHints ? resolveDeployLogHint(cleanedMessage) : '';
  const prefix = isToolLog(item) ? (context ? TOOL_CONTEXT_LOG_PREFIX : TOOL_LOG_PREFIX) : '';
  const body = `${prefix}${cleanedMessage}`;
  return hint ? `${body}${LOG_HINT_PREFIX}${hint}` : body;
}

/** 是否为「仅错误与告警」模式关注的级别 */
export function isAttentionLevel(level: DeployLogItem['level'] | undefined): boolean {
  return level === 'error' || level === 'warn';
}

/** 「仅错误与告警」模式下的展示项 */
export interface AttentionLogEntry<T> {
  /** 原始日志项 */
  item: T;
  /** 是否因失败上下文保护而保留（本身不是 error / warn） */
  context: boolean;
}

/**
 * 「仅错误与告警」过滤，附带失败上下文保护（#46）。
 * - error / warn 行照常保留；
 * - 工具输出（source=tool）出现 error 行后，同一段工具输出的后续行（`file:` 定位、堆栈等 info 行）全部保留并标记为 context，
 *   直到下一条雨燕系统日志（非工具输出）为止；
 * - 其余 info / success 行过滤掉。
 * 只在展示层生效，不改变落库级别。
 * @param logs 日志列表（按时间顺序）
 * @returns 过滤后的展示项
 */
export function filterAttentionLogs<T extends Pick<DeployLogItem, 'level' | 'source'>>(logs: T[]): AttentionLogEntry<T>[] {
  const entries: AttentionLogEntry<T>[] = [];
  let protecting = false;
  for (const item of logs) {
    if (!isToolLog(item)) {
      // 下一条雨燕系统日志：结束本段工具输出的上下文保护
      protecting = false;
      if (isAttentionLevel(item.level)) entries.push({ item, context: false });
      continue;
    }
    if (item.level === 'error') protecting = true;
    if (isAttentionLevel(item.level)) {
      entries.push({ item, context: false });
    } else if (protecting) {
      entries.push({ item, context: true });
    }
  }
  return entries;
}

/**
 * 进度事件是否代表发布失败。
 * 工具原始输出的 error 行（如被自动重试兜住的 OOM、Yarn 缓存损坏）不代表整次发布失败，
 * 只有雨燕系统判定的 error 日志或 error 事件才算。
 * @param event 进度事件
 */
export function isDeployFailureEvent(event: {
  type: string;
  level?: DeployLogItem['level'];
  source?: DeployLogItem['source'];
}): boolean {
  if (event.type === 'error') return true;
  return event.type === 'log' && event.level === 'error' && !isToolLog(event);
}

/** 日志级别图例项 */
export interface DeployLogLegendItem {
  /** 级别标识，与 Monaco log 高亮一致 */
  level: DeployLogItem['level'] | 'tool' | 'context';
  /** 用户语义 */
  label: string;
  /** 用户需要做什么 */
  description: string;
}

/** 日志级别图例（统一用户语义） */
export const DEPLOY_LOG_LEGEND: DeployLogLegendItem[] = [
  { level: 'info', label: '进度', description: '雨燕的执行说明，正常过程' },
  { level: 'success', label: '成功', description: '阶段完成' },
  { level: 'warn', label: '提醒', description: '可能有问题，不一定导致失败' },
  { level: 'error', label: '错误', description: '导致本次失败，优先查看' },
  { level: 'tool', label: '工具输出', description: '以 │ 开头，git / pnpm / vite 等工具原始输出，失败时请结合上下文查看' },
];

/** 失败上下文图例（仅「仅错误与告警」模式展示） */
export const DEPLOY_LOG_CONTEXT_LEGEND: DeployLogLegendItem = {
  level: 'context',
  label: '失败上下文',
  description: '以 ┆ 开头并弱化显示：错误行之后同一段工具输出（如文件定位、堆栈），保留到下一条雨燕系统日志为止',
};
