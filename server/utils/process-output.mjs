/**
 * 子进程输出规范化工具
 * @description 统一处理构建 / Git / 后端命令的终端输出，使其适合在发布日志面板中阅读：
 * 1. 去除 ANSI 颜色与光标控制码（CI=true 时 picocolors 等库会强制输出颜色）；
 * 2. 处理 `\r` 回车覆盖式进度行，仅保留最终可见内容；
 * 3. stderr 不等于告警：git / vite / pnpm 会把正常进度写入 stderr，按内容分 error / warn / info 三档（#46）。
 */

/**
 * 日志来源：工具原始输出（git / pnpm / vite / maven 等子进程 stdout、stderr）。
 * 未标记 source 的日志视为雨燕自身的系统说明（system）。
 */
export const TOOL_LOG_SOURCE = 'tool';

/** ANSI 转义序列（CSI 颜色 / 光标控制 + OSC 超链接 / 标题） */
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** 除换行 / 制表 / 回车外的其他 C0 控制字符（含残留的孤立 ESC） */
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * 明确的告警前缀：以告警开头的行即使后文出现错误类名也只算 warn
 * （如 `WARN  deprecated some-error-lib@1.0.0`、`(!) Plugin xxx: ...`）。
 */
const STDERR_WARN_PREFIX_PATTERN = /^(?:\(!\)|\[WARN(?:ING)?\]|WARN\b|warn(?:ing)?\b\s*[:\]]|npm warn\b)/i;

/**
 * 导致本次失败的错误语义（命中即判为 error）。
 * - 工具错误前缀：`error during build:`、`error: ...`、`fatal: ...`、`npm ERR!`、`npm error`、`[ERROR]`、`error TS2307`
 * - 包管理器失败：`ELIFECYCLE`、`Command failed`、`ERR_PNPM_*`、`ERR!`
 * - 构建失败：`✗ Build failed`、`x Build failed in 262ms`、`Transform failed`、`Could not resolve`、`failed to resolve import`
 * - 内存：`Killed`（内核 OOM killer）、`heap out of memory`
 * - 错误类名：`RollupError:`、`SyntaxError:`、`TypeError:`、`Error [ERR_MODULE_NOT_FOUND]:`，可带 `[vite:vue]` 等前缀
 */
const STDERR_ERROR_PATTERNS = [
  /^(?:error|fatal)(?![\w-])/i,
  /^npm (?:ERR!|error\b)/i,
  /\bFATAL ERROR\b/,
  /\[(?:ERROR|FATAL)\]/i,
  /(?:^|[\s:])ERROR(?![\w-])/,
  /\berror TS\d+\b/i,
  /\bELIFECYCLE\b/,
  /\bCommand failed\b/i,
  /\bERR_PNPM_\w+/,
  /\bERR!/,
  /\b(?:Build|Transform|Compilation) failed\b/i,
  /\bCould not resolve\b/i,
  /\bfailed to resolve (?:import|entry)\b/i,
  /\bKilled\b/,
  /\bheap out of memory\b/i,
  /^(?:\[[^\]]*\]:?\s*)*[A-Z]?\w*Error\b(?:\s*\[[^\]]*\])?\s*(?::|$)/,
  /(?:^|[\s(:\]])[A-Z]?\w*Error(?:\s*\[[^\]]*\])?:(?:\s|$)/,
];

/** JS 堆栈帧行 */
const STACK_FRAME_PATTERN = /^at\s+(?:async\s+)?\S/;

/** stderr 中仍值得提示的告警关键字（未命中错误语义时判为 warn） */
const STDERR_ATTENTION_PATTERN =
  /\b(?:warn(?:ing)?|deprecated|errors?|fatal|failed|failure|exception|denied|refused|cannot|unable|timed? ?out|abort(?:ed)?|panic)\b|can't|not found|no such file|[✗✘×]|^\(!\)/i;

/**
 * 不应被当成告警 / 错误的普通短语：`0 errors`、`Errors: 0`、`no warnings`、`no-error`、`error-boundary.js` 等。
 * 判级前先剔除，避免误伤普通 info 行。
 */
const STDERR_BENIGN_PATTERN = /\b(?:0|no|zero)\s+(?:errors?|warnings?)\b|\b(?:errors?|warnings?)\s*:\s*0\b|[\w.]*-(?:errors?|warn(?:ings?)?|fatal|fail(?:ed|ure)?)\b[\w.-]*|\b(?:errors?|warn(?:ings?)?|fatal|fail(?:ed|ure)?)-[\w.-]*/gi;

/**
 * 去除文本中的 ANSI 转义序列与不可见控制字符。
 * @param {string} text - 原始文本
 * @returns {string} 纯文本
 */
export function stripAnsi(text) {
  return String(text ?? '')
    .replace(ANSI_PATTERN, '')
    .replace(CONTROL_CHAR_PATTERN, '');
}

/**
 * 将一段子进程输出拆分为可读日志行。
 * - 去除 ANSI 控制码；
 * - 对 `\r` 覆盖式进度（如 `transforming (12) xxx\rtransforming (13) yyy`）仅保留最后一段；
 * - 去除首尾空白并过滤空行。
 * @param {string | Buffer} chunk - 子进程输出片段
 * @returns {string[]} 规范化后的日志行
 */
export function splitProcessOutputLines(chunk) {
  return stripAnsi(String(chunk ?? ''))
    .split(/\r?\n/)
    .map((line) => {
      const segments = line.split('\r').map((segment) => segment.trim()).filter(Boolean);
      return segments.length ? segments[segments.length - 1] : '';
    })
    .filter(Boolean);
}

/**
 * 按内容判定 stderr 日志行级别（三档）。
 * - error：导致本次失败的错误语义（见 {@link STDERR_ERROR_PATTERNS}），失败时用户应优先查看；
 * - warn：告警语义（warn / deprecated / `(!)` 等），可能有问题但不一定导致失败；
 * - info：其余普通进度（git / vite / pnpm 写入 stderr 的正常输出）。
 * @param {string} line - 已规范化的日志行
 * @returns {'info' | 'warn' | 'error'} 日志级别
 */
export function resolveStderrLogLevel(line) {
  const text = String(line || '').trim();
  if (!text) return 'info';
  if (STDERR_WARN_PREFIX_PATTERN.test(text)) return 'warn';
  // 堆栈帧（`at error (file:///...)`、`at getRollupError (...)`）只是失败上下文，函数名里的 error 不代表告警
  if (STACK_FRAME_PATTERN.test(text)) return 'info';
  const meaningful = text.replace(STDERR_BENIGN_PATTERN, ' ');
  if (STDERR_ERROR_PATTERNS.some((pattern) => pattern.test(meaningful))) return 'error';
  return STDERR_ATTENTION_PATTERN.test(meaningful) ? 'warn' : 'info';
}
