/**
 * 子进程输出规范化工具
 * @description 统一处理构建 / Git / 后端命令的终端输出，使其适合在发布日志面板中阅读：
 * 1. 去除 ANSI 颜色与光标控制码（CI=true 时 picocolors 等库会强制输出颜色）；
 * 2. 处理 `\r` 回车覆盖式进度行，仅保留最终可见内容；
 * 3. stderr 不等于告警：git / vite / pnpm 会把正常进度写入 stderr，按内容判定级别。
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

/** stderr 中真正值得提示的告警 / 错误关键字 */
const STDERR_ATTENTION_PATTERN =
  /\b(?:warn(?:ing)?|deprecated|errors?|fatal|failed|failure|exception|denied|refused|cannot|unable|timed? ?out|abort(?:ed)?|panic)\b|can't|not found|no such file|ERR!|[✗✘×]|^\(!\)/i;

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
 * 按内容判定 stderr 日志行级别。
 * 仅当包含告警 / 错误语义时标记为 warn，其余视为普通进度信息，避免误导用户。
 * @param {string} line - 已规范化的日志行
 * @returns {'info' | 'warn'} 日志级别
 */
export function resolveStderrLogLevel(line) {
  return STDERR_ATTENTION_PATTERN.test(String(line || '')) ? 'warn' : 'info';
}
