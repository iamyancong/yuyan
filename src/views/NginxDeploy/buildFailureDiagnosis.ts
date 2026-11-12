/**
 * 构建失败诊断（#58）
 * @description 按命令真实输出归因构建失败原因，替代旧版「关键字全量扫描」：
 * 1. 命令文本（pnpm/npm/yarn 的 `> cmd` 回显、雨燕「执行构建产物 1/2：cmd」、失败汇总行）不参与分类，只用于提取失败命令与退出码；
 * 2. 只在失败命令自己的输出段内找第一条真实致命错误，后续 ELIFECYCLE / Command failed 等当作噪音；
 * 3. 推断 `&&` 链中真正失败的子步骤（vite build 失败时，后面的预算脚本根本没执行）；
 * 4. 摘录第一条报错前后的原始输出，与本地执行 `pnpm build` 失败时看到的一致。
 *
 * 纯 TS 模块：只允许 `import type`，以便 `node --experimental-strip-types --test` 直接运行。
 * 所有正则均为线性匹配（无嵌套量词），且单行先截断到 {@link MAX_LINE_LENGTH} 再匹配，避免超长日志拖慢页面。
 */

import type { DeployErrorSummary, DeployLogItem, DeployRecord } from '../../api/deploy';

/** 单行参与匹配的最大长度 */
const MAX_LINE_LENGTH = 2000;
/** 失败输出段的最大扫描行数（超出时扫描首尾各一半，保证不漏掉段首的第一条报错） */
const MAX_SCAN_LINES = 20000;
/** 原始报错摘录最大行数 */
const MAX_EXCERPT_LINES = 20;
/** 摘录向后统计剩余行数时的扫描上限 */
const MAX_EXCERPT_LOOKAHEAD = 2000;
/** 其余报错计数上限 */
const MAX_OTHER_ERRORS = 99;
/** 弱信号分类（只说明“出错了”，不说明原因） */
const WEAK_CATEGORIES = new Set(['构建报错', '包管理器报错']);
/** 弱信号之后继续寻找具体原因的行数 */
const WEAK_LOOKAHEAD_LINES = 15;

/** ANSI 转义序列（CSI 颜色 / 光标控制 + OSC 超链接 / 标题） */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
/** 除换行 / 制表 / 回车外的不可见控制字符 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

// ─── 命令文本与噪音 ───

/** 包管理器脚本回显：`> pkg@1.0.0 build /path`、`> vite build && ...` */
const SCRIPT_ECHO_RE = /^>\s+\S/;
/** 包管理器脚本回显中的包信息行：`> pkg@1.0.0 build [path]` */
const SCRIPT_PKG_INFO_RE = /^>\s+(?:@[^\s/]+\/)?[^\s@]+@\S+\s+\S+/;
/** yarn 回显：`$ vite build` */
const YARN_ECHO_RE = /^\$\s+\S/;
/** 雨燕多行命令系统日志：`执行构建产物 1/2：pnpm build` */
const YUYAN_EXEC_RE = /^执行(.{1,40}?)\s(\d+)\/(\d+)[:：]\s*(.+)$/;
/** 雨燕失败汇总首行：`构建产物 执行失败，退出码 1`、`构建产物 2/2 执行失败，退出码 null（信号 SIGKILL）` */
const YUYAN_FAIL_RE = /^(.{1,60}?)\s*执行失败[，,]\s*退出码\s*([^\s（(]+)\s*(?:[（(]信号\s*([A-Z0-9]+)\s*[）)])?/;
/** 汇总首行中的多命令序号 */
const YUYAN_FAIL_INDEX_RE = /\s(\d+)\/\d+$/;
/** 包管理器失败尾巴：只说明“失败了”，不说明原因 */
const PM_FAILURE_TAIL_RE =
  /\bELIFECYCLE\b|Command failed with exit code|ERR_PNPM_RECURSIVE_(?:RUN|EXEC)_FIRST_FAIL\b(?!.*not found)|^npm (?:ERR!|error) (?:code ELIFECYCLE|errno|path|command|Lifecycle script|A complete log|Failed at the|This is probably not a problem|\s*$|in workspace|at location)|^error Command failed\b|^info Visit https:\/\/yarnpkg|^npm (?:ERR!|error) \S+@\S+ \w+: `/i;
/** vite 失败引导行 */
const ERROR_DURING_BUILD_RE = /^error during build\s*:?\s*$/i;
/** vite 配置加载失败引导行 */
const VITE_CONFIG_FAIL_RE = /^failed to load config from\s+(\S+)/i;
/** vite 构建失败标记 */
const BUILD_FAILED_MARKER_RE = /^[x✗✘×]\s+Build failed\b/i;
/** 堆栈帧 */
const STACK_FRAME_RE = /^at\s+\S/;
/** Node 抛错时打印的源码位置行：`file:///x/check.mjs:286` */
const NODE_SOURCE_POINTER_RE = /^(?:file:\/\/)?(?:[A-Za-z]:)?[/\\][^\s:]+\.(?:m?js|cjs|ts|mts|cts):\d+$/;
/** Node 抛错时打印的 `^` 指示行 */
const CARET_RE = /^\^+$/;
/** Node 版本尾巴：`Node.js v20.11.0` */
const NODE_VERSION_TAIL_RE = /^Node\.js v\d+\.\d+\.\d+$/;
/** CJS Require stack */
const REQUIRE_STACK_RE = /^Require stack:$/;
const REQUIRE_STACK_ITEM_RE = /^-\s+(\S+)/;
/** 告警前缀：以告警开头的行只在找不到真正错误时才参与归因（与后端 #46 分级口径一致） */
const WARN_PREFIX_RE = /^(?:\(!\)|\[WARN(?:ING)?\]|WARN\b|warn(?:ing)?\b\s*[:\]]|npm warn\b|warning\b)/i;
/** 看起来像错误的普通短语：`0 errors`、`errors: 0`、`no errors` */
const BENIGN_ERROR_PHRASE_RE = /\b(?:0|no|zero)\s+errors?\b|\berrors?\s*:\s*0\b/i;

// ─── 各分类规则 ───

const TS_ERROR_PAREN_RE = /^(\S+?\.(?:[cm]?tsx?|vue))\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.*)$/;
const TS_ERROR_COLON_RE = /^(\S+?\.(?:[cm]?tsx?|vue)):(\d+):(\d+)\s+-\s+error\s+(TS\d+):\s*(.*)$/;
const TS_ERROR_ANY_RE = /\berror\s+(TS\d+):\s*(.*)$/;
const TS_FOUND_ERRORS_RE = /^Found (\d+) errors?\b/;

const CANNOT_FIND_RE = /Cannot find (package|module) ['"]([^'"]+)['"](?:\s+imported from\s+(\S+))?/;

const ROLLUP_RESOLVE_RE = /Rollup failed to resolve import "([^"]+)" from "([^"]+)"/;
const FAILED_RESOLVE_IMPORT_RE = /Failed to resolve import "([^"]+)" from "([^"]+)"/;
const COULD_NOT_RESOLVE_RE = /Could not resolve ["']([^"']+)["'](?: from ["']([^"']+)["'])?/;
const FAILED_RESOLVE_ENTRY_RE = /Failed to resolve entry for package\s+"([^"]+)"/i;

const LOCKFILE_RE =
  /ERR_PNPM_(?:OUTDATED_LOCKFILE|LOCKFILE_CONFIG_MISMATCH|LOCKFILE_BREAKING_CHANGE|FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE|LOCKFILE_MISSING_DEPENDENCY)|`npm ci` can only install packages when your package\.json and package-lock\.json|Your lockfile needs to be updated|The lockfile would have been modified by this install|is not up to date with \S*package\.json/i;
const LOCKFILE_TARGET_RE = /not up to date with (\S*package\.json)/i;

const FETCH_404_RE = /ERR_PNPM_FETCH_404|\bE404\b|404 Not Found\s*-\s*GET|ERR_PNPM_NO_MATCHING_VERSION|No matching version found for|notarget No matching version/i;
const FETCH_AUTH_RE = /ERR_PNPM_FETCH_40[13]|\bE40[13]\b|401 Unauthorized|403 Forbidden|Unable to authenticate|authentication token not provided/i;
const CERT_RE = /self[- ]signed certificate|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|unable to get local issuer certificate/i;
const NETWORK_RE =
  /ERR_PNPM_META_FETCH_FAIL|ERR_PNPM_TARBALL_\w+|ERR_PNPM_FETCH_\d+|\bETIMEDOUT\b|\bESOCKETTIMEDOUT\b|\bECONNRESET\b|\bECONNREFUSED\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bERR_SOCKET_TIMEOUT\b|socket hang up|getaddrinfo\s+\w+/i;
const REGISTRY_URL_RE = /(https?:\/\/[^\s"'`]+)/;

const NODE_ENGINE_RE =
  /ERR_PNPM_UNSUPPORTED_ENGINE|Unsupported engine|The engine "node" is incompatible|requires Node\.js version|Node\.js version [^\s]+ is not supported|Please upgrade your Node\.js version/i;
const NODE_CURRENT_RE = /(?:You are using Node\.js|Got:?\s*|Your Node version is incompatible|current:\s*\{\s*node:\s*['"]?)\s*v?(\d+\.\d+\.\d+)/i;
const NODE_API_MISSING_RE =
  /crypto\$?\d*\.getRandomValues is not a function|structuredClone is not defined|(?:Array\.prototype\.)?(?:toSorted|findLast|at) is not a function|ERR_REQUIRE_ESM|Unexpected token '(?:\?\?=|\|\|=|&&=|\?\.|\.)'|SyntaxError: Unexpected token '\?'/;
const UNKNOWN_EXT_RE = /ERR_UNKNOWN_FILE_EXTENSION.*?(\.\w+)/;

const MISSING_SCRIPT_RE = /Missing script:?\s*["']?([\w:.-]+)["']?|^(?:error )?Command "([\w:.-]+)" not found|ERR_PNPM_NO_SCRIPT/i;

const COMMAND_NOT_FOUND_RES: RegExp[] = [
  /^(?:\/bin\/)?(?:ba|z|da)?sh:\s*(?:line\s+)?(?:\d+:\s*)?([\w@./-]+):\s*(?:command\s+)?not found/i,
  /^([\w@./-]+):\s*command not found/i,
  /^'([^']+)'\s*不是内部或外部命令/,
  /^'([^']+)' is not recognized as an internal or external command/i,
  /spawn\s+([\w@./\\-]+)\s+ENOENT/,
  /ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL\s+Command "([^"]+)" not found/,
];
const NODE_MODULES_MISSING_RE = /Local package\.json exists, but node_modules missing/i;

const OOM_RE = /JavaScript heap out of memory|Allocation failed - process out of memory|FatalProcessOutOfMemory/i;
const KILLED_RE = /^Killed\b|terminated by signal (?:9|SIGKILL)|\bsignal SIGKILL\b|^SIGKILL$/i;

const ENOSPC_WATCHER_RE = /ENOSPC:? System limit for number of file watchers reached/i;
const ENOSPC_RE = /\bENOSPC\b|no space left on device|磁盘空间不足/i;
const PERMISSION_RE = /\b(EACCES|EPERM)\b|permission denied/i;
const PERMISSION_PATH_RE = /(?:EACCES|EPERM)[^,]*,\s*\w+\s+'([^']+)'/;

const ESBUILD_ERROR_RE = /^[✘x×]\s*\[ERROR\]\s*(.+)$/;
const ESBUILD_LOCATION_RE = /^((?:[A-Za-z]:)?[^\s:]+\.\w+):(\d+):(\d+):?(?:\s+ERROR:\s*(.*))?$/;
const TRANSFORM_FAILED_RE = /Transform failed with (\d+) errors?/i;
const VITE_PLUGIN_ERROR_RE = /^\[(vite:[\w-]+|plugin:?\s*vite:[\w-]+|commonjs--resolver|@vitejs\/[\w-]+)\]\s*(.*)$/i;
const VUE_COMPILER_ERROR_RE = /^\[vite:vue\]\s*(.*)$/i;
const SYNTAX_ERROR_RE = /^(?:\[[^\]\s]{1,60}\]\s*)?SyntaxError:\s*(.+)$/;
const ROLLUP_FILE_LINE_RE = /^file:\s*(\S+)/;

const SASS_ERROR_RE = /\[sass\]\s*(.+)$|^Error:\s*((?:Undefined (?:variable|mixin|function)|Can't find stylesheet to import|expected "[^"]*"|Invalid CSS after)[^\n]*)$/i;
const SASS_LOCATION_RE = /^((?:[A-Za-z]:)?[^\s]+\.s[ac]ss)\s+(\d+):(\d+)\s/;
const LESS_ERROR_RE = /\[less\]\s*(.+)$|^(?:LessError|\[vite:css\]\s*\[less\]):?\s*(.+)$/i;
const LESS_LOCATION_RE = /in\s+(\S+\.less)\s+on line\s+(\d+),\s*column\s+(\d+)/i;
const POSTCSS_ERROR_RE = /\[postcss\]\s*(.+)$|CssSyntaxError:\s*(.+)$/i;

const HEAVY_RUNTIME_RE = /首屏静态依赖包含重型运行时依赖/;
const BUDGET_EXCEED_RE =
  /页面预算超出|超出(?:页面)?(?:体积)?预算|预算超(?:出|限)|体积超(?:出|过)(?:预算|上限|阈值)|page budget exceeded|budget exceeded|exceeds? (?:the )?(?:page |size )?budget|over budget/i;
const BUDGET_SCRIPT_RE = /(?:check-)?page-budget|budget\.(?:m?js|cjs|ts)/i;

const GENERIC_ERROR_RE = /^(?:Uncaught\s+)?(?:\[[^\]\s]{1,60}\]:?\s*)?([A-Z]\w{0,40}Error|Error)(?:\s*\[([A-Z0-9_]+)\])?:\s*(.+)$/;
const TOOL_ERROR_LINE_RE = /^(?:\[ERROR\]|ERROR|error|fatal|npm (?:ERR!|error))[:\s]\s*(.+)$/;
const PNPM_ERR_CODE_RE = /\b(ERR_PNPM_[A-Z0-9_]+)\b\s*(.*)$/;

// ─── 类型 ───

/** 展平后的日志行 */
interface FlatLine {
  /** 行号（1 开始，与 Monaco 展示行号对应） */
  lineIndex: number;
  /** 去 ANSI、去首尾空白并截断后的文本 */
  clean: string;
  /** 去 ANSI、保留缩进的原始文本（用于原始报错摘录） */
  raw: string;
  /** 是否工具原始输出：true 工具 / false 雨燕系统说明 / undefined 未知（旧记录） */
  tool?: boolean;
  /** 是否位于雨燕失败汇总消息的正文（汇总首行之后重复的 stderr） */
  inSummaryBody: boolean;
  /** 是否为雨燕失败汇总首行 */
  isSummaryHead: boolean;
}

/** 单条分类结果 */
interface Classification {
  category: string;
  title: string;
  violation?: string;
  fileLocation?: string;
  suggestion: string;
  stage: string;
}

/** 失败命令上下文 */
interface CommandContext {
  failedCommand: string;
  steps: string[];
  /** steps[i] 与 steps[i+1] 之间的连接符 */
  separators: string[];
  exitCode?: number | string;
}

/** 诊断选项 */
export interface DiagnoseBuildFailureOptions {
  /** 发布记录：status=failed 时，即使没有识别到失败汇总也给出兜底诊断 */
  record?: Pick<DeployRecord, 'status'> | null;
}

// ─── 文本工具 ───

/**
 * 去除 ANSI 转义与不可见控制字符。
 * @param text 原始文本
 * @returns 纯文本
 */
function stripAnsi(text: string): string {
  return String(text ?? '').replace(ANSI_PATTERN, '').replace(CONTROL_CHAR_PATTERN, '');
}

/**
 * 处理 `\r` 覆盖式进度：只保留最后一段可见内容。
 * @param line 单行文本（不含换行）
 * @returns 可见文本
 */
function resolveCarriageReturn(line: string): string {
  if (!line.includes('\r')) return line;
  const segments = line.split('\r').filter((segment) => segment.trim());
  return segments.length ? segments[segments.length - 1] : '';
}

/**
 * 截断超长行。
 * @param text 文本
 * @returns 截断后的文本
 */
function truncate(text: string, max = MAX_LINE_LENGTH): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 把构建工作区内的绝对路径还原为仓库相对路径。
 * - 去掉 `file://` 前缀与 Windows 反斜杠；
 * - `vite.config.ts.timestamp-<数字>-<hex>.mjs` 还原为 `vite.config.ts`；
 * - `/…/deploy-data/cache/workspaces/<id>/<hash>/repo/` 前缀裁掉。
 * @param rawPath 原始路径（可带 `:行:列`）
 * @returns 展示用路径
 */
export function toRepoRelativePath(rawPath: string): string {
  let p = String(rawPath || '').trim().replace(/^["'`(]+/, '').replace(/["'`),]+$/, '');
  p = p.replace(/^file:\/\//i, '');
  if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
  p = p.replace(/\\/g, '/');
  p = p.replace(/\.timestamp-\d+(?:-[0-9a-f]+)?\.mjs(?=$|:)/i, '');
  const marker = '/deploy-data/cache/workspaces/';
  const markerIndex = p.indexOf(marker);
  if (markerIndex >= 0) {
    const rest = p.slice(markerIndex + marker.length).replace(/^[^/]+\/[^/]+\/repo\//, '');
    if (rest !== p.slice(markerIndex + marker.length)) p = rest;
  }
  return p;
}

/**
 * 从模块说明符提取 npm 包名：`@scope/pkg/sub` → `@scope/pkg`，`pkg/sub` → `pkg`。
 * @param specifier 模块说明符
 * @returns 包名
 */
export function extractPackageName(specifier: string): string {
  const s = String(specifier || '').trim().replace(/^node:/, '');
  const parts = s.split('/');
  return s.startsWith('@') && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

/**
 * 是否为文件路径类说明符（相对路径、绝对路径、file://、Windows 盘符）。
 * @param specifier 模块说明符
 */
function isPathSpecifier(specifier: string): boolean {
  return /^(?:\.{1,2}[/\\]|[/\\]|file:|[A-Za-z]:[/\\]|~\/|@\/)/.test(specifier) || specifier === '.' || specifier === '..';
}

/**
 * 取路径所在目录（仓库相对）。
 * @param repoPath 仓库相对路径
 * @returns 目录；位于仓库根时返回空字符串
 */
function dirnameOf(repoPath: string): string {
  const withoutPos = repoPath.replace(/:\d+(?::\d+)?$/, '');
  const index = withoutPos.lastIndexOf('/');
  return index > 0 ? withoutPos.slice(0, index) : '';
}

/**
 * 提取 node_modules 路径中的所属包名（取最后一个 node_modules 后的包）。
 * @param repoPath 路径
 * @returns 包名；不在 node_modules 内返回空字符串
 */
function ownerPackageInNodeModules(repoPath: string): string {
  const index = repoPath.lastIndexOf('node_modules/');
  if (index < 0) return '';
  return extractPackageName(repoPath.slice(index + 'node_modules/'.length));
}

// ─── 日志展平与命令上下文 ───

/**
 * 将日志列表展平为逐行列表，行号与 Monaco 展示保持一致（每条日志按 `\n` 拆行）。
 * @param logs 日志列表
 * @returns 展平后的行
 */
function flattenLogs(logs: DeployLogItem[]): FlatLine[] {
  const result: FlatLine[] = [];
  let lineIndex = 1;
  for (const item of logs) {
    const message = stripAnsi(String(item?.message ?? ''));
    const parts = message.split(/\r?\n/);
    const tool = item?.source === 'tool' ? true : item?.source === undefined ? undefined : false;
    const isSummary = YUYAN_FAIL_RE.test(resolveCarriageReturn(parts[0] || '').trim());
    parts.forEach((part, partIndex) => {
      const visible = resolveCarriageReturn(part);
      result.push({
        lineIndex,
        clean: truncate(visible.trim()),
        raw: truncate(visible.replace(/\s+$/, '')),
        tool: isSummary ? false : tool,
        inSummaryBody: isSummary && partIndex > 0,
        isSummaryHead: isSummary && partIndex === 0,
      });
      lineIndex++;
    });
  }
  return result;
}

/**
 * 按 `&&` / `||` / `;` 拆分 shell 命令（引号内不拆）。
 * @param command 命令
 * @returns 子步骤与连接符
 */
export function splitCommandSteps(command: string): { steps: string[]; separators: string[] } {
  const steps: string[] = [];
  const separators: string[] = [];
  let current = '';
  let quote = '';
  const text = String(command || '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    const pair = text.slice(i, i + 2);
    if (pair === '&&' || pair === '||' || ch === ';') {
      const sep = ch === ';' ? ';' : pair;
      if (current.trim()) {
        steps.push(current.trim());
        separators.push(sep);
      }
      current = '';
      if (sep !== ';') i++;
      continue;
    }
    current += ch;
  }
  if (current.trim()) steps.push(current.trim());
  return { steps, separators: separators.slice(0, Math.max(0, steps.length - 1)) };
}

/**
 * 提取失败命令、子步骤与退出码。
 * @param lines 展平行
 * @param regionStart 失败输出段起点
 * @param summaryIndex 失败汇总首行下标（-1 表示没有）
 * @returns 命令上下文
 */
function extractCommandContext(lines: FlatLine[], regionStart: number, summaryIndex: number): CommandContext {
  const end = summaryIndex >= 0 ? summaryIndex : lines.length;
  let exitCode: number | string | undefined;
  let failedIndex = 0;
  if (summaryIndex >= 0) {
    const head = lines[summaryIndex].clean.match(YUYAN_FAIL_RE);
    if (head) {
      const code = head[2];
      if (head[3]) exitCode = head[3];
      else if (/^-?\d+$/.test(code)) exitCode = Number(code);
      else if (code !== 'null' && code !== 'undefined') exitCode = code;
      const indexMatch = head[1].match(YUYAN_FAIL_INDEX_RE);
      if (indexMatch) failedIndex = Number(indexMatch[1]);
    }
  }

  // 1. 失败段内包管理器回显的实际脚本命令（`> pkg@ver build` 之后那一行）
  let echoCommand = '';
  for (let i = Math.max(0, regionStart - 2); i < end; i++) {
    const { clean } = lines[i];
    if (SCRIPT_PKG_INFO_RE.test(clean)) {
      const next = lines[i + 1]?.clean || '';
      if (SCRIPT_ECHO_RE.test(next) && !SCRIPT_PKG_INFO_RE.test(next)) echoCommand = next.replace(/^>\s+/, '');
    } else if (YARN_ECHO_RE.test(clean) && !echoCommand) {
      echoCommand = clean.replace(/^\$\s+/, '');
    }
  }

  // 2. 雨燕多行命令日志「执行构建产物 N/M：cmd」
  let execCommand = '';
  for (let i = 0; i < end; i++) {
    const match = lines[i].clean.match(YUYAN_EXEC_RE);
    if (match && (!failedIndex || Number(match[2]) === failedIndex)) execCommand = match[4];
  }

  if (exitCode === undefined) {
    for (let i = regionStart; i < end; i++) {
      const match = lines[i].clean.match(/(?:Command failed with exit code|exited with code)\s+(\d+)/i);
      if (match) {
        exitCode = Number(match[1]);
        break;
      }
    }
  }

  const failedCommand = echoCommand || execCommand;
  const { steps, separators } = splitCommandSteps(failedCommand);
  return { failedCommand, steps, separators, exitCode };
}

// ─── 行判定 ───

/**
 * 是否为只描述“失败了”而不描述原因的噪音 / 命令文本行。
 * @param clean 行文本
 */
function isNoiseLine(clean: string): boolean {
  if (!clean) return true;
  return (
    SCRIPT_ECHO_RE.test(clean) ||
    YARN_ECHO_RE.test(clean) ||
    YUYAN_EXEC_RE.test(clean) ||
    YUYAN_FAIL_RE.test(clean) ||
    PM_FAILURE_TAIL_RE.test(clean) ||
    ERROR_DURING_BUILD_RE.test(clean) ||
    VITE_CONFIG_FAIL_RE.test(clean) ||
    BUILD_FAILED_MARKER_RE.test(clean) ||
    STACK_FRAME_RE.test(clean) ||
    CARET_RE.test(clean) ||
    NODE_SOURCE_POINTER_RE.test(clean) ||
    NODE_VERSION_TAIL_RE.test(clean) ||
    REQUIRE_STACK_RE.test(clean) ||
    /^throw\s/.test(clean) ||
    /^-\s+\//.test(clean)
  );
}

/**
 * 是否为告警行（只在找不到真正错误时才参与归因）。
 * @param clean 行文本
 */
function isWarnLine(clean: string): boolean {
  return WARN_PREFIX_RE.test(clean);
}

/**
 * 在当前行之后的若干行里找第一条满足条件的匹配。
 * @param lines 展平行
 * @param from 起始下标（不含）
 * @param pattern 正则
 * @param limit 向后最多查看的行数
 */
function lookAhead(lines: FlatLine[], from: number, pattern: RegExp, limit = 6): RegExpMatchArray | null {
  for (let i = from + 1; i < Math.min(lines.length, from + 1 + limit); i++) {
    const match = lines[i].clean.match(pattern);
    if (match) return match;
  }
  return null;
}

/**
 * 从当前行之后的堆栈帧中取第一个位于项目源码（非 node 内部、非 node_modules）的位置。
 * @param lines 展平行
 * @param from 当前行下标
 */
function firstProjectFrame(lines: FlatLine[], from: number): string {
  for (let i = from + 1; i < Math.min(lines.length, from + 15); i++) {
    const { clean } = lines[i];
    if (!STACK_FRAME_RE.test(clean)) {
      if (clean) break;
      continue;
    }
    const match = clean.match(/\(?((?:file:\/\/)?(?:[A-Za-z]:)?[/\\][^\s()]+?:\d+(?::\d+)?)\)?$/);
    if (match && !/node:internal|[/\\]node_modules[/\\]/.test(match[1])) return toRepoRelativePath(match[1]);
  }
  return '';
}

/**
 * 当前行之后的堆栈帧是否出自预算脚本。
 * @param lines 展平行
 * @param from 当前行下标
 */
function thrownByBudgetScript(lines: FlatLine[], from: number): boolean {
  for (let i = Math.max(0, from - 4); i < Math.min(lines.length, from + 8); i++) {
    const { clean } = lines[i];
    if ((STACK_FRAME_RE.test(clean) || NODE_SOURCE_POINTER_RE.test(clean)) && BUDGET_SCRIPT_RE.test(clean)) return true;
  }
  return false;
}

// ─── 分类 ───

/**
 * 依赖缺失 / 模块找不到的诊断。
 * @param specifier 模块说明符
 * @param importerRaw 引用文件原始路径
 */
function classifyMissingModule(specifier: string, importerRaw: string): Classification {
  const importer = importerRaw ? toRepoRelativePath(importerRaw) : '';
  if (isPathSpecifier(specifier)) {
    const target = toRepoRelativePath(specifier);
    return {
      category: '模块导入失败',
      title: '找不到引用的文件',
      violation: target,
      fileLocation: importer || undefined,
      suggestion: `找不到文件 "${target}"${importer ? `（被 ${importer} 引用）` : ''}。\n请检查路径拼写、大小写（Linux 区分大小写）、文件后缀，以及该文件是否已提交到仓库。`,
      stage: 'build',
    };
  }
  const pkg = extractPackageName(specifier);
  const owner = ownerPackageInNodeModules(importer);
  if (owner) {
    return {
      category: '依赖缺失',
      title: `依赖包 ${owner} 需要的 ${pkg} 未安装`,
      violation: pkg,
      fileLocation: importer || undefined,
      suggestion: `${owner} 运行时需要 ${pkg}，但 node_modules 中找不到。\n通常是依赖安装不完整、peerDependencies 未安装或版本不兼容。\n在部署配置中勾选「本次重新安装依赖」重试；仍失败时在项目 package.json 中显式添加 ${pkg} 并提交更新后的锁文件。`,
      stage: 'build',
    };
  }
  const dir = dirnameOf(importer);
  const pkgJson = dir ? `${dir}/package.json` : 'package.json';
  return {
    category: '依赖缺失',
    title: `找不到依赖包 ${pkg}`,
    violation: pkg,
    fileLocation: importer || undefined,
    suggestion: [
      `${importer || '构建代码'} 引用了 ${pkg}，但安装目录里没有这个包，构建在读取${/vite\.config/.test(importer) ? '配置文件' : '代码'}时就失败了。`,
      `在 ${pkgJson} 的 devDependencies（构建工具/插件）或 dependencies 中声明 ${pkg}，本地执行 pnpm install 后连同锁文件一起提交。`,
      dir ? `这是 monorepo 子目录 ${dir}：依赖要声明在 ${pkgJson}，只装在根目录或本机全局时，服务器上不一定能解析到。` : '',
      '如果已经声明过，确认锁文件已同步提交，或在部署配置中勾选「本次重新安装依赖」。',
    ]
      .filter(Boolean)
      .join('\n'),
    stage: 'build',
  };
}

/**
 * 对单行进行分类；未命中返回 null。
 * @param lines 展平行
 * @param index 行下标
 * @returns 分类结果
 */
function classifyLine(lines: FlatLine[], index: number): Classification | null {
  const clean = lines[index].clean;
  if (isNoiseLine(clean) || BENIGN_ERROR_PHRASE_RE.test(clean)) return null;
  let m: RegExpMatchArray | null;

  // TypeScript 类型错误（优先于 Cannot find module，TS2307 也属于类型检查）
  if ((m = clean.match(TS_ERROR_PAREN_RE) || clean.match(TS_ERROR_COLON_RE))) {
    return {
      category: 'TypeScript 类型错误',
      title: 'TypeScript 类型校验未通过',
      violation: `${m[4]}: ${m[5]}`,
      fileLocation: `${toRepoRelativePath(m[1])}:${m[2]}:${m[3]}`,
      suggestion: '类型检查（vue-tsc / tsc）发现错误，构建在打包前就停止了。\n按报错位置修复类型错误后重新提交；本地执行同一构建命令可复现。',
      stage: 'type-check',
    };
  }
  if ((m = clean.match(TS_ERROR_ANY_RE))) {
    return {
      category: 'TypeScript 类型错误',
      title: 'TypeScript 类型校验未通过',
      violation: `${m[1]}: ${m[2]}`,
      suggestion: '类型检查（vue-tsc / tsc）发现错误，构建在打包前就停止了。\n按报错位置修复类型错误后重新提交；本地执行同一构建命令可复现。',
      stage: 'type-check',
    };
  }

  // 依赖缺失 / 模块找不到
  if ((m = clean.match(CANNOT_FIND_RE))) {
    let importer = m[3] || '';
    if (!importer && lookAhead(lines, index, REQUIRE_STACK_RE, 3)) {
      const item = lookAhead(lines, index, REQUIRE_STACK_ITEM_RE, 5);
      if (item) importer = item[1];
    }
    if (!importer) importer = firstProjectFrame(lines, index);
    return classifyMissingModule(m[2], importer);
  }

  // vite / rollup 导入解析失败
  if ((m = clean.match(ROLLUP_RESOLVE_RE) || clean.match(FAILED_RESOLVE_IMPORT_RE))) {
    const result = classifyMissingModule(m[1], m[2]);
    if (result.category === '模块导入失败') return { ...result, title: '无法解析导入路径' };
    return { ...result, title: `无法解析依赖包 ${result.violation}` };
  }
  if ((m = clean.match(FAILED_RESOLVE_ENTRY_RE))) {
    return {
      category: '依赖解析失败',
      title: '未能正确解析依赖包入口',
      violation: m[1],
      fileLocation: 'package.json',
      suggestion: `未能在项目中正确解析依赖包 "${m[1]}"。请检查 package.json 是否声明了该依赖、版本的 main/module/exports 是否可用，或在部署配置中勾选“本次重新安装依赖”。`,
      stage: 'build',
    };
  }
  if ((m = clean.match(COULD_NOT_RESOLVE_RE))) {
    return classifyMissingModule(m[1], m[2] || '');
  }

  // 锁文件不一致
  if (LOCKFILE_RE.test(clean)) {
    const code = clean.match(/ERR_PNPM_\w+/)?.[0] || '';
    const target = clean.match(LOCKFILE_TARGET_RE)?.[1] || '';
    if (code === 'ERR_PNPM_LOCKFILE_BREAKING_CHANGE') {
      return {
        category: '锁文件不一致',
        title: '锁文件格式与服务器 pnpm 版本不兼容',
        violation: code,
        suggestion: '项目 pnpm-lock.yaml 由不同大版本的 pnpm 生成。\n在 package.json 中用 packageManager 固定 pnpm 版本，并用该版本重新生成锁文件后提交。',
        stage: 'install',
      };
    }
    return {
      category: '锁文件不一致',
      title: '锁文件与 package.json 不同步',
      violation: code || truncate(clean, 300),
      fileLocation: target ? toRepoRelativePath(target) : undefined,
      suggestion: `${target ? `${toRepoRelativePath(target)} 的依赖` : 'package.json 的依赖'}改了，但锁文件没有同步更新，按锁文件安装（--frozen-lockfile / npm ci）时被拒绝。\n本地执行 pnpm install（或 npm install / yarn install）后，把更新后的锁文件一起提交。`,
      stage: 'install',
    };
  }

  // 依赖下载失败
  if (FETCH_404_RE.test(clean)) {
    return {
      category: '依赖下载失败',
      title: '依赖包或版本在 npm 源上不存在',
      violation: truncate(clean, 300),
      suggestion: '请求的包或版本在当前 npm 源上找不到。\n检查包名、版本号是否拼错；私有包请确认 .npmrc 中该 scope 指向了公司私服，且私服已同步该版本。',
      stage: 'install',
    };
  }
  if (FETCH_AUTH_RE.test(clean)) {
    return {
      category: '依赖下载失败',
      title: 'npm 私服鉴权失败（401/403）',
      violation: truncate(clean, 300),
      suggestion: '访问 npm 源时被拒绝。\n检查部署目标的 npm 私服配置与凭据是否有效、是否有该包的读取权限。',
      stage: 'install',
    };
  }
  if (CERT_RE.test(clean)) {
    return {
      category: '依赖下载失败',
      title: 'npm 源 HTTPS 证书校验失败',
      violation: truncate(clean, 300),
      suggestion: '构建机无法校验 npm 源的 HTTPS 证书（自签名或过期）。\n在构建机安装公司根证书（NODE_EXTRA_CA_CERTS），或修复私服证书。',
      stage: 'install',
    };
  }
  if (NETWORK_RE.test(clean)) {
    const url = clean.match(REGISTRY_URL_RE)?.[1] || '';
    const dns = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(clean);
    return {
      category: '依赖下载失败',
      title: dns ? 'npm 源域名解析失败' : '连接 npm 源超时或被断开',
      violation: url || truncate(clean, 300),
      suggestion: dns
        ? '构建机解析不了 npm 源域名。检查构建机 DNS 与 .npmrc 中的 registry 地址。'
        : '下载依赖时网络超时或连接被重置。检查构建机到 npm 源的网络、代理与防火墙，稍后重试。',
      stage: 'install',
    };
  }

  // Node 版本不符
  if (NODE_ENGINE_RE.test(clean)) {
    const current = clean.match(NODE_CURRENT_RE)?.[1] || '';
    const wanted = clean.match(/(?:requires Node\.js version|Wanted:?\s*\{?\s*"?node"?:?\s*|engines?\.node[^\d>^~]*)\s*["']?([\^~>=<\d][^"',}\s]*(?:\s*\|\|\s*[\^~>=<\d][^"',}\s]*)*)/i)?.[1] || '';
    return {
      category: 'Node 版本不符',
      title: 'Node.js 版本不满足项目要求',
      violation: [current && `当前 ${current}`, wanted && `要求 ${wanted}`].filter(Boolean).join('，') || truncate(clean, 300),
      suggestion: '构建机的 Node.js 版本不满足项目 engines 或构建工具（如 Vite 5 需要 Node 18+）的要求。\n升级构建机 Node 版本，或在项目中使用兼容当前 Node 的工具版本。',
      stage: 'build',
    };
  }
  if (NODE_API_MISSING_RE.test(clean)) {
    const inDeps = /node_modules/.test(clean) || Boolean(lookAhead(lines, index, /node_modules/, 6));
    if (inDeps || /getRandomValues|structuredClone|ERR_REQUIRE_ESM/.test(clean)) {
      return {
        category: 'Node 版本不符',
        title: 'Node.js 版本过低，不支持依赖使用的语法或 API',
        violation: truncate(clean, 300),
        suggestion: '依赖包使用了当前 Node.js 不支持的语法或 API（如 crypto.getRandomValues、structuredClone、??=、ESM require）。\n升级构建机 Node.js 版本（建议 18 或更高）后重试。',
        stage: 'build',
      };
    }
  }
  if ((m = clean.match(UNKNOWN_EXT_RE))) {
    return {
      category: 'Node 版本不符',
      title: `Node.js 无法直接执行 ${m[1]} 文件`,
      violation: truncate(clean, 300),
      suggestion: `当前 Node.js 不能直接加载 ${m[1]} 文件。\n检查脚本是否需要 tsx / ts-node 等加载器，或 package.json 的 type 字段与文件后缀是否匹配。`,
      stage: 'build',
    };
  }

  // 缺少 npm script
  if ((m = clean.match(MISSING_SCRIPT_RE))) {
    const script = m[1] || m[2] || 'build';
    return {
      category: '缺少脚本',
      title: `package.json 中没有 "${script}" 脚本`,
      violation: script,
      suggestion: `执行目录下的 package.json 没有定义 scripts.${script}。\n检查构建命令是否在正确的子目录执行（如 cd packages && pnpm build），或在 package.json 中补上该脚本。`,
      stage: 'build',
    };
  }

  // 命令未安装
  for (const pattern of COMMAND_NOT_FOUND_RES) {
    if ((m = clean.match(pattern))) {
      const cmd = m[1];
      return {
        category: '命令未安装',
        title: `找不到命令 ${cmd}`,
        violation: cmd,
        suggestion: `执行时找不到 ${cmd}。\n如果它来自 npm 包（如 vite、vue-tsc），说明依赖未安装或未在 package.json 中声明：确认已声明并在部署配置中勾选「本次重新安装依赖」。\n如果是系统命令，请在构建机上安装它。`,
        stage: 'build',
      };
    }
  }
  if (NODE_MODULES_MISSING_RE.test(clean)) {
    return {
      category: '命令未安装',
      title: '依赖尚未安装（node_modules 不存在）',
      violation: truncate(clean, 300),
      suggestion: '执行目录有 package.json 但没有 node_modules，构建依赖的命令都不可用。\n确认部署目标配置了依赖安装命令且在正确目录执行（monorepo 子目录需要在子目录或根目录安装）。',
      stage: 'install',
    };
  }

  // 内存与进程
  if (OOM_RE.test(clean)) {
    return {
      category: '构建内存溢出',
      title: 'Node.js 堆内存耗尽 (OOM)',
      suggestion: '打包构建消耗内存超出上限。系统会自动按更大内存重试；如果仍然失败，请在部署目标中调高「最低构建内存」。',
      stage: 'build',
    };
  }
  if (KILLED_RE.test(clean)) {
    return {
      category: '进程被系统终止',
      title: '构建进程被强制结束（SIGKILL）',
      violation: truncate(clean, 300),
      suggestion: '构建进程被操作系统强制结束，最常见的是机器物理内存不足触发 OOM killer（与 Node 堆溢出不同，不会自动重试）。\n减少同时进行的构建、调高构建机内存，或在部署目标中调高「最低构建内存」。',
      stage: 'build',
    };
  }

  // 系统资源 / 权限
  if (ENOSPC_WATCHER_RE.test(clean)) {
    return {
      category: '系统资源限制',
      title: '文件监听数达到系统上限',
      violation: 'ENOSPC (inotify)',
      suggestion: '这不是磁盘满，而是 inotify 文件监听数达到上限，通常是构建命令误用了 watch / dev 模式。\n确认构建命令不带 --watch；必要时调大 fs.inotify.max_user_watches。',
      stage: 'build',
    };
  }
  if (ENOSPC_RE.test(clean)) {
    return {
      category: '磁盘空间不足',
      title: '构建机磁盘空间不足',
      violation: truncate(clean, 300),
      suggestion: '写文件时磁盘已满（ENOSPC）。\n清理构建机磁盘（旧构建工作区、依赖缓存、日志），或扩容后重试。',
      stage: 'build',
    };
  }
  if (PERMISSION_RE.test(clean)) {
    const target = clean.match(PERMISSION_PATH_RE)?.[1] || '';
    return {
      category: '权限不足',
      title: '文件或目录权限不足',
      violation: target ? toRepoRelativePath(target) : truncate(clean, 300),
      suggestion: `${target ? `访问 ${toRepoRelativePath(target)} 时` : ''}没有权限（EACCES / EPERM）。\n检查构建工作区与缓存目录的属主和权限，避免用 root 安装过依赖后再用普通用户构建。`,
      stage: 'build',
    };
  }

  // 首屏重型依赖门禁（check-build-bundle）
  if (HEAVY_RUNTIME_RE.test(clean) && !/\$\{/.test(clean)) {
    let violation = clean.match(/首屏静态依赖包含重型运行时依赖[:：]?\s*(.*)/)?.[1]?.trim() || '';
    if (!violation) violation = clean.match(/assets\/[^\s"')]+/)?.[0] || '';
    let fileLocation = '';
    for (let j = Math.max(0, index - 6); j <= Math.min(lines.length - 1, index + 3); j++) {
      const loc = lines[j].clean.match(/(?:file:\/\/)?(\S*?scripts\/[^\s:()]+:\d+)/);
      if (loc) {
        fileLocation = toRepoRelativePath(loc[1]).replace(/^.*?(scripts\/)/, '$1');
        break;
      }
    }
    return {
      category: '工程门禁拦截',
      title: '首屏静态依赖包含重型运行时依赖',
      violation: violation || clean.replace(/^Error:\s*/i, ''),
      fileLocation: fileLocation || 'scripts/check-build-bundle.mjs',
      suggestion: '检测到首屏静态资源包含了未按需拆分的重型库（如 Monaco、ECharts、Sheet 等）。请检查 main.ts、App.vue 或路由顶层，避免全局静态 import，改为按需或 defineAsyncComponent 异步加载。',
      stage: 'check-build-bundle',
    };
  }

  // 页面预算超限：必须是预算脚本自己的输出
  if (BUDGET_EXCEED_RE.test(clean) || (GENERIC_ERROR_RE.test(clean) && thrownByBudgetScript(lines, index))) {
    return {
      category: '性能预算门禁',
      title: '首屏页面打包体积超出预设上限',
      violation: truncate(clean.replace(/^Error:\s*/, ''), 300),
      suggestion: '页面预算脚本检测到首屏分包体积超出阈值（打包本身已成功）。\n使用 dynamic import() 拆分非首屏组件或优化 manualChunks；确需放宽时调整预算配置。',
      stage: 'check-page-budget',
    };
  }

  // esbuild / vite 转换与语法错误
  if ((m = clean.match(ESBUILD_ERROR_RE))) {
    const loc = lookAhead(lines, index, ESBUILD_LOCATION_RE, 4);
    return {
      category: '语法/转换错误',
      title: '源码编译失败',
      violation: truncate(m[1], 300),
      fileLocation: loc ? `${toRepoRelativePath(loc[1])}:${loc[2]}:${loc[3]}` : undefined,
      suggestion: 'esbuild 编译源码失败，通常是语法错误或使用了目标环境不支持的语法。\n按报错位置修复后重新提交。',
      stage: 'build',
    };
  }
  if (TRANSFORM_FAILED_RE.test(clean)) {
    const loc = lookAhead(lines, index, ESBUILD_LOCATION_RE, 4);
    return {
      category: '语法/转换错误',
      title: '源码编译失败',
      violation: truncate(loc?.[4] || clean, 300),
      fileLocation: loc ? `${toRepoRelativePath(loc[1])}:${loc[2]}:${loc[3]}` : undefined,
      suggestion: 'esbuild 编译源码失败，通常是语法错误或使用了目标环境不支持的语法。\n按报错位置修复后重新提交。',
      stage: 'build',
    };
  }

  // 样式编译错误
  if ((m = clean.match(SASS_ERROR_RE))) {
    const loc = lookAhead(lines, index, SASS_LOCATION_RE, 10);
    return {
      category: '样式编译错误',
      title: 'Sass/SCSS 编译失败',
      violation: truncate((m[1] || m[2] || clean).trim(), 300),
      fileLocation: loc ? `${toRepoRelativePath(loc[1])}:${loc[2]}:${loc[3]}` : undefined,
      suggestion: 'Sass 编译出错，常见原因是变量/mixin 未定义或 @import/@use 路径错误。\n按报错位置修复；如果使用了全局变量，检查 vite 配置中的 additionalData。',
      stage: 'build',
    };
  }
  if ((m = clean.match(LESS_ERROR_RE))) {
    const loc = clean.match(LESS_LOCATION_RE) || lookAhead(lines, index, LESS_LOCATION_RE, 4);
    return {
      category: '样式编译错误',
      title: 'Less 编译失败',
      violation: truncate((m[1] || m[2] || clean).replace(LESS_LOCATION_RE, '').trim(), 300),
      fileLocation: loc ? `${toRepoRelativePath(loc[1])}:${loc[2]}:${loc[3]}` : undefined,
      suggestion: 'Less 编译出错，常见原因是变量未定义或 @import 路径错误。\n按报错位置修复；如果依赖全局变量，检查 vite 配置中的 modifyVars / additionalData。',
      stage: 'build',
    };
  }
  if ((m = clean.match(POSTCSS_ERROR_RE))) {
    return {
      category: '样式编译错误',
      title: 'PostCSS 处理样式失败',
      violation: truncate((m[1] || m[2] || clean).trim(), 300),
      suggestion: 'PostCSS 处理样式时出错。检查报错样式文件的语法与 postcss 插件配置。',
      stage: 'build',
    };
  }

  // Vue 单文件组件编译错误 / 其他 vite 插件错误
  if ((m = clean.match(VUE_COMPILER_ERROR_RE)) || (m = clean.match(SYNTAX_ERROR_RE))) {
    const file = lookAhead(lines, index, ROLLUP_FILE_LINE_RE, 4)?.[1] || '';
    return {
      category: '语法/转换错误',
      title: /vite:vue/i.test(clean) ? 'Vue 组件编译失败' : '源码语法错误',
      violation: truncate(m[1], 300),
      fileLocation: file ? toRepoRelativePath(file) : undefined,
      suggestion: '源码存在语法错误，打包时无法解析。\n按报错位置修复后重新提交。',
      stage: 'build',
    };
  }
  if ((m = clean.match(VITE_PLUGIN_ERROR_RE))) {
    const file = lookAhead(lines, index, ROLLUP_FILE_LINE_RE, 4)?.[1] || '';
    return {
      category: '构建插件报错',
      title: `Vite 插件 ${m[1]} 处理失败`,
      violation: truncate(m[2] || clean, 300),
      fileLocation: file ? toRepoRelativePath(file) : undefined,
      suggestion: '打包插件处理文件时出错，具体原因见原始报错输出。',
      stage: 'build',
    };
  }

  // 通用异常
  if ((m = clean.match(GENERIC_ERROR_RE))) {
    const message = m[3].trim();
    const location = firstProjectFrame(lines, index);
    return {
      category: '异常抛错',
      title: truncate(message, 200),
      violation: truncate(`${m[1]}${m[2] ? ` [${m[2]}]` : ''}: ${message}`, 300),
      fileLocation: location || undefined,
      suggestion: '构建代码或脚本抛出了未处理的异常，请按原始报错输出与堆栈排查。',
      stage: 'build',
    };
  }
  if ((m = clean.match(PNPM_ERR_CODE_RE))) {
    return {
      category: '包管理器报错',
      title: `pnpm 执行出错（${m[1]}）`,
      violation: truncate(m[2] || m[1], 300),
      suggestion: 'pnpm 执行失败，具体原因见原始报错输出。',
      stage: 'install',
    };
  }
  if ((m = clean.match(TOOL_ERROR_LINE_RE))) {
    return {
      category: '构建报错',
      title: truncate(m[1].trim(), 200),
      violation: truncate(m[1].trim(), 300),
      suggestion: '构建工具输出了错误，具体原因见原始报错输出。',
      stage: 'build',
    };
  }
  return null;
}

// ─── 失败段与子步骤 ───

/**
 * 确定失败命令的输出段：失败汇总首行之前连续的一段工具输出。
 * @param lines 展平行
 * @param summaryIndex 失败汇总首行下标
 * @returns 段落起点（含）与终点（不含）
 */
function resolveFailureRegion(lines: FlatLine[], summaryIndex: number): { start: number; end: number } {
  if (summaryIndex < 0) return { start: 0, end: lines.length };
  const hasSourceInfo = lines.some((line) => line.tool === true);
  let start = summaryIndex;
  if (hasSourceInfo) {
    while (start > 0 && lines[start - 1].tool === true) start--;
  } else {
    // 旧记录没有 source：从最近一条「执行构建产物 N/M」之后开始，否则从头开始
    start = 0;
    for (let i = summaryIndex - 1; i >= 0; i--) {
      if (YUYAN_EXEC_RE.test(lines[i].clean)) {
        start = i + 1;
        break;
      }
    }
  }
  return { start, end: summaryIndex };
}

/**
 * 超长段落只扫描首尾各一半，返回需要扫描的下标列表。
 * @param start 起点
 * @param end 终点（不含）
 */
function scanIndexes(start: number, end: number): number[] {
  const indexes: number[] = [];
  if (end - start <= MAX_SCAN_LINES) {
    for (let i = start; i < end; i++) indexes.push(i);
    return indexes;
  }
  const half = Math.floor(MAX_SCAN_LINES / 2);
  for (let i = start; i < start + half; i++) indexes.push(i);
  for (let i = end - half; i < end; i++) indexes.push(i);
  return indexes;
}

/**
 * 推断 `&&` 链中失败的子步骤。
 * @param lines 展平行
 * @param region 失败段
 * @param ctx 命令上下文
 * @param primaryIndex 主错误下标（-1 表示未识别）
 * @param primary 主错误分类
 */
function inferFailedStep(
  lines: FlatLine[],
  region: { start: number; end: number },
  ctx: CommandContext,
  primaryIndex: number,
  primary: Classification | null
): { failedStep?: string; skippedSteps?: string[] } {
  const { steps, separators } = ctx;
  if (!steps.length) return {};
  const pick = (index: number) => {
    const allAnd = separators.slice(index).every((sep) => sep === '&&');
    const skipped = allAnd ? steps.slice(index + 1) : [];
    return { failedStep: steps[index], skippedSteps: skipped.length ? skipped : undefined };
  };
  if (steps.length === 1) return pick(0);

  const limit = primaryIndex >= 0 ? primaryIndex : region.end;
  const scriptName = (step: string) => step.match(/([\w.-]+\.(?:m?js|cjs|m?ts))(?:\s|$)/)?.[1] || '';
  const isVite = (step: string) => /\bvite(?:\s+build|\.js\s+build)\b|\bvue-cli-service\s+build\b/.test(step);
  const isTsc = (step: string) => /\b(?:vue-tsc|tsc)\b/.test(step);

  // 1. 主错误堆栈 / 源码位置指向某个脚本
  if (primaryIndex >= 0) {
    for (let i = Math.max(region.start, primaryIndex - 4); i < Math.min(region.end, primaryIndex + 12); i++) {
      const { clean } = lines[i];
      if (!STACK_FRAME_RE.test(clean) && !NODE_SOURCE_POINTER_RE.test(clean)) continue;
      const hit = steps.findIndex((step) => scriptName(step) && clean.includes(scriptName(step)));
      if (hit >= 0) return pick(hit);
    }
  }
  // 2. 按分类直接对应
  if (primary?.stage === 'check-page-budget') {
    const hit = steps.findIndex((step) => BUDGET_SCRIPT_RE.test(step));
    if (hit >= 0) return pick(hit);
  }
  if (primary?.stage === 'check-build-bundle') {
    const hit = steps.findIndex((step) => /build-bundle/.test(step));
    if (hit >= 0) return pick(hit);
  }
  if (primary?.stage === 'type-check') {
    const hit = steps.findIndex(isTsc);
    if (hit >= 0) return pick(hit);
  }
  // 3. vite：主错误之前没有出现 `✓ built in`，说明打包没完成，失败在 vite 这一步
  const viteIndex = steps.findIndex(isVite);
  if (viteIndex >= 0) {
    let built = false;
    for (let i = region.start; i < limit; i++) {
      if (/^✓\s*built in\b/i.test(lines[i].clean)) built = true;
    }
    if (!built) {
      // vite 之前的步骤（如 vue-tsc）没有报错特征时，认定失败在 vite
      return pick(viteIndex);
    }
    // 打包已完成：失败在 vite 之后，取有输出痕迹的最后一个脚本步骤，否则取 vite 的下一步
    let last = -1;
    for (let s = viteIndex + 1; s < steps.length; s++) {
      const name = scriptName(steps[s]);
      if (!name) continue;
      const base = name.replace(/\.\w+$/, '');
      for (let i = region.start; i <= Math.min(region.end - 1, limit + 8); i++) {
        const { clean } = lines[i];
        if (!isNoiseLine(clean) || STACK_FRAME_RE.test(clean) || NODE_SOURCE_POINTER_RE.test(clean)) {
          if (clean.includes(name) || clean.includes(`[${base}]`)) last = s;
        }
      }
    }
    return pick(last >= 0 ? last : Math.min(viteIndex + 1, steps.length - 1));
  }
  return {};
}

/**
 * 截取主错误附近的原始输出（与本地执行构建命令看到的一致）。
 * @param lines 展平行
 * @param region 失败段
 * @param primaryIndex 主错误下标
 * @returns 摘录与省略行数
 */
function extractExcerpt(
  lines: FlatLine[],
  region: { start: number; end: number },
  primaryIndex: number
): { excerpt: string; omitted: number } {
  const isLeadIn = (clean: string) =>
    VITE_CONFIG_FAIL_RE.test(clean) ||
    ERROR_DURING_BUILD_RE.test(clean) ||
    BUILD_FAILED_MARKER_RE.test(clean) ||
    NODE_SOURCE_POINTER_RE.test(clean) ||
    CARET_RE.test(clean) ||
    /^throw\s/.test(clean) ||
    /^\[vite\]/.test(clean);
  let start = primaryIndex;
  for (let i = primaryIndex - 1; i >= Math.max(region.start, primaryIndex - 6); i--) {
    const { clean } = lines[i];
    if (!clean) continue;
    if (!isLeadIn(clean)) break;
    start = i;
  }
  const isTerminator = (line: FlatLine) =>
    line.isSummaryHead || (line.tool === false && !line.inSummaryBody) || PM_FAILURE_TAIL_RE.test(line.clean);

  const collected: string[] = [];
  let omitted = 0;
  let previousBlank = false;
  const stop = Math.min(region.end, start + MAX_EXCERPT_LOOKAHEAD);
  for (let i = start; i < stop; i++) {
    const line = lines[i];
    if (i > primaryIndex && isTerminator(line)) break;
    if (SCRIPT_ECHO_RE.test(line.clean) || YUYAN_EXEC_RE.test(line.clean)) continue;
    const blank = !line.clean;
    if (blank && (previousBlank || !collected.length)) continue;
    previousBlank = blank;
    // 后端按行记录时去掉了缩进：堆栈帧补回 4 个空格，与 Node 原始输出一致
    const text = STACK_FRAME_RE.test(line.raw) ? `    ${line.raw}` : line.raw;
    if (collected.length < MAX_EXCERPT_LINES) collected.push(text);
    else if (!blank) omitted++;
  }
  while (collected.length && !collected[collected.length - 1].trim()) collected.pop();
  return { excerpt: collected.join('\n'), omitted };
}

/**
 * 失败段最后若干行原始输出（未识别具体原因时展示）。
 * @param lines 展平行
 * @param region 失败段
 */
function tailExcerpt(lines: FlatLine[], region: { start: number; end: number }): string {
  const tail: string[] = [];
  for (let i = region.end - 1; i >= region.start && tail.length < 10; i--) {
    const { clean, raw } = lines[i];
    if (!clean || SCRIPT_ECHO_RE.test(clean)) continue;
    tail.unshift(raw);
  }
  return tail.join('\n');
}

/**
 * 只有退出码 / 信号时的兜底诊断。
 * @param exitCode 退出码或信号
 * @param hasOutput 失败段是否有输出
 */
function classifyExitCode(exitCode: number | string | undefined, hasOutput: boolean): Classification {
  const outputHint = hasOutput ? '没有从输出中识别出具体原因，请查看下方原始输出与上方完整日志。' : '命令没有输出任何报错信息。';
  if (exitCode === 137 || exitCode === 'SIGKILL') {
    return {
      category: '进程被系统终止',
      title: '构建进程被强制结束（SIGKILL / 137）',
      suggestion: `${outputHint}\n退出码 137 / SIGKILL 通常是机器物理内存不足触发 OOM killer，或被外部强制结束。减少并发构建、调高构建机内存，或调高「最低构建内存」。`,
      stage: 'build',
    };
  }
  if (exitCode === 143 || exitCode === 'SIGTERM') {
    return {
      category: '进程被终止',
      title: '构建进程收到终止信号（SIGTERM / 143）',
      suggestion: `${outputHint}\n进程被外部终止，常见于发布超时或被手动停止。`,
      stage: 'build',
    };
  }
  if (exitCode === 127) {
    return {
      category: '命令未安装',
      title: '命令不存在（退出码 127）',
      suggestion: `${outputHint}\n退出码 127 表示找不到要执行的命令，确认依赖已安装、命令拼写正确。`,
      stage: 'build',
    };
  }
  if (exitCode === 126) {
    return {
      category: '权限不足',
      title: '命令不可执行（退出码 126）',
      suggestion: `${outputHint}\n退出码 126 表示文件存在但没有执行权限。`,
      stage: 'build',
    };
  }
  return {
    category: '执行失败',
    title: exitCode !== undefined ? `构建命令异常退出（退出码 ${exitCode}）` : '构建产物或发布流程执行失败，退出码非 0',
    suggestion: hasOutput ? outputHint : `${outputHint}\n本地在相同目录执行同一构建命令，并用 echo $? 查看退出码排查。`,
    stage: 'build',
  };
}

// ─── 入口 ───

/**
 * 按真实输出诊断构建失败原因。
 * @param logs 发布日志
 * @param options 选项
 * @returns 错误根因诊断；无法判断为失败时返回 null
 */
export function diagnoseBuildFailure(
  logs: DeployLogItem[] = [],
  options: DiagnoseBuildFailureOptions = {}
): DeployErrorSummary | null {
  if (!Array.isArray(logs) || !logs.length) return null;
  const lines = flattenLogs(logs);
  const summaryIndex = lines.findIndex((line) => line.isSummaryHead);
  const region = resolveFailureRegion(lines, summaryIndex);
  const ctx = extractCommandContext(lines, region.start, summaryIndex);
  const hasSourceInfo = lines.some((line) => line.tool === true);

  // 候选顺序：失败段内非告警行 → 失败段内告警行 → 汇总正文（无工具输出的旧记录）→ 无汇总时全量
  const regionIndexes = scanIndexes(region.start, region.end);
  const summaryBodyIndexes: number[] = [];
  if (summaryIndex >= 0) {
    for (let i = summaryIndex + 1; i < lines.length && lines[i].inSummaryBody; i++) summaryBodyIndexes.push(i);
  }
  const passes: number[][] = [
    regionIndexes.filter((i) => !lines[i].inSummaryBody && !isWarnLine(lines[i].clean)),
    regionIndexes.filter((i) => !lines[i].inSummaryBody && isWarnLine(lines[i].clean)),
  ];
  if (!hasSourceInfo || region.end - region.start === 0) {
    passes.push(scanIndexes(summaryBodyIndexes[0] ?? 0, (summaryBodyIndexes[summaryBodyIndexes.length - 1] ?? -1) + 1));
  }

  let primary: Classification | null = null;
  let primaryIndex = -1;
  let passUsed: number[] = [];
  for (const pass of passes) {
    for (let k = 0; k < pass.length; k++) {
      const result = classifyLine(lines, pass[k]);
      if (!result) continue;
      primary = result;
      primaryIndex = pass[k];
      passUsed = pass;
      // 泛化的「error: xxx」类结果只是弱信号：紧随其后的几行若有具体原因（如 npm error code 之后的说明），以具体原因为准
      if (WEAK_CATEGORIES.has(result.category)) {
        for (let n = k + 1; n < Math.min(pass.length, k + 1 + WEAK_LOOKAHEAD_LINES); n++) {
          const better = classifyLine(lines, pass[n]);
          if (better && !WEAK_CATEGORIES.has(better.category)) {
            primary = better;
            primaryIndex = pass[n];
            break;
          }
        }
      }
      break;
    }
    if (primary) break;
  }

  // 摘录与段落：主错误位于汇总正文时，以汇总正文为段落
  const excerptRegion =
    primaryIndex >= 0 && lines[primaryIndex].inSummaryBody
      ? { start: summaryIndex + 1, end: summaryIndex + 1 + summaryBodyIndexes.length }
      : region;

  let excerpt = '';
  let omitted = 0;
  let otherErrorCount = 0;
  if (primary) {
    ({ excerpt, omitted } = extractExcerpt(lines, excerptRegion, primaryIndex));
    const primaryKey = `${primary.category}|${primary.violation || primary.title}`;
    const seen = new Set<string>([primaryKey]);
    for (const index of passUsed) {
      if (index <= primaryIndex || otherErrorCount >= MAX_OTHER_ERRORS) continue;
      const result = classifyLine(lines, index);
      if (!result || WEAK_CATEGORIES.has(result.category)) continue;
      const key = `${result.category}|${result.violation || result.title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      otherErrorCount++;
    }
  } else {
    const failed = summaryIndex >= 0 || options.record?.status === 'failed';
    if (!failed) return null;
    const hasOutput = regionIndexes.some((i) => lines[i].clean && !isNoiseLine(lines[i].clean));
    if (summaryIndex < 0) {
      // 不是命令执行失败（如上传 / SSH 阶段失败），沿用旧兜底：附最后 5 条日志
      return {
        stage: 'build',
        category: '执行失败',
        title: '构建产物或发布流程执行失败，退出码非 0',
        suggestion: '命令执行以非 0 状态码退出，请查看下方控制台日志排查。',
        detail: logs.slice(-5).map((item) => item.message).join('\n'),
        lineIndex: lines.length,
      };
    }
    primary = classifyExitCode(ctx.exitCode, hasOutput);
    excerpt = hasOutput ? tailExcerpt(lines, region) : '';
  }

  const stepInfo = inferFailedStep(lines, region, ctx, primaryIndex, primary);
  const summary: DeployErrorSummary = {
    stage: primary.stage,
    category: primary.category,
    title: primary.title,
    suggestion: primary.suggestion,
    lineIndex: primaryIndex >= 0 ? lines[primaryIndex].lineIndex : summaryIndex >= 0 ? lines[summaryIndex].lineIndex : lines.length,
  };
  if (primary.violation) summary.violation = primary.violation;
  if (primary.fileLocation) summary.fileLocation = primary.fileLocation;
  if (excerpt) {
    summary.excerpt = excerpt;
    summary.rawDetail = excerpt;
  }
  if (omitted) summary.excerptOmittedLines = omitted;
  if (ctx.failedCommand) summary.failedCommand = ctx.failedCommand;
  if (stepInfo.failedStep && ctx.steps.length > 1) summary.failedStep = stepInfo.failedStep;
  if (stepInfo.skippedSteps?.length) summary.skippedSteps = stepInfo.skippedSteps;
  if (ctx.exitCode !== undefined) summary.exitCode = ctx.exitCode;
  if (otherErrorCount) summary.otherErrorCount = otherErrorCount;
  return summary;
}
