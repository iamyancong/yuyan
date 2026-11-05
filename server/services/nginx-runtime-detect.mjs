/**
 * 托管 / 接入已有 Nginx 的进程识别、pid 解析与 status 输出解析（纯函数，便于单测）。
 */

/**
 * 当前 yuyan-nginx.sh 脚本协议版本。远端缺标记或版本低于此值时应刷新脚本。
 */
export const YUYAN_NGINX_SCRIPT_VERSION = 2;

/**
 * 脚本中的版本标记前缀。
 */
export const YUYAN_NGINX_SCRIPT_VERSION_MARKER = '# yuyan-nginx-script-version:';

/**
 * 归一化 POSIX 路径：去尾斜杠；空串保持空。
 * @param {string} input - 原始路径
 * @returns {string}
 */
export function normalizePosixPath(input) {
  const text = String(input || '').trim().replace(/\\/g, '/');
  if (!text) return '';
  if (text === '/') return '/';
  return text.replace(/\/+$/, '');
}

/**
 * 判断 candidate 是否「属于」base 实例根（严格前缀，避免 /opt/yuyan/nginx 误匹配 /opt/yuyan/nginx2）。
 * @param {string} candidate - 命令行或路径片段
 * @param {string} baseDir - 实例安装根
 * @returns {boolean}
 */
export function pathBelongsToBase(candidate, baseDir) {
  const base = normalizePosixPath(baseDir);
  const value = String(candidate || '');
  if (!base || !value) return false;
  const baseSlash = `${base}/`;
  if (value === base) return true;
  if (value.startsWith(baseSlash)) return true;
  // cmdline 中常带 -p /base/ 或 -c /base/conf/...
  if (value.includes(`${baseSlash}`) || value.includes(` ${base} `) || value.includes(` ${base}/`) || value.endsWith(` ${base}`)) {
    // 再挡 nginx2：若 base 后紧跟非分隔符字母数字则不算
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[\\s=])${escaped}(?=$|[\\s/])`);
    return re.test(value);
  }
  return false;
}

/**
 * 从 nginx.conf 文本解析 pid 指令（忽略注释行）。
 * @param {string} confText - 配置文本
 * @param {string} prefix - -p 前缀（安装根）
 * @returns {{ directive: string|null, absolutePath: string|null, candidates: string[] }}
 */
export function parseNginxPidDirective(confText, prefix) {
  const base = normalizePosixPath(prefix);
  let directive = null;
  for (const rawLine of String(confText || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const match = line.match(/^pid\s+([^;]+);?\s*$/i);
    if (match) {
      directive = match[1].trim().replace(/^["']|["']$/g, '');
      break;
    }
  }
  const candidates = [];
  const push = (rel) => {
    if (!rel) return;
    const abs = rel.startsWith('/') ? normalizePosixPath(rel) : normalizePosixPath(`${base}/${rel}`);
    if (abs && !candidates.includes(abs)) candidates.push(abs);
  };
  if (directive) push(directive);
  // nginx 默认相对 prefix 的 logs/nginx.pid；雨燕初始化写 run/nginx.pid
  push('run/nginx.pid');
  push('logs/nginx.pid');
  return {
    directive,
    absolutePath: directive
      ? directive.startsWith('/')
        ? normalizePosixPath(directive)
        : normalizePosixPath(`${base}/${directive}`)
      : null,
    candidates,
  };
}

/**
 * 解析 yuyan-nginx.sh status / 操作的机器可读输出。
 * @param {string} output - stdout+stderr
 * @returns {Object}
 */
export function parseRuntimeScriptStatusOutput(output) {
  const text = String(output || '');
  const read = (key) => {
    const match = text.match(new RegExp(`(?:^|\\n)${key}:\\s*(.+)(?:\\n|$)`));
    return match ? match[1].trim() : '';
  };
  const pid = Number(read('running') || read('pid') || 0) || 0;
  const stopped = /(^|\n)stopped(\n|$)/.test(text) && !pid;
  const needsSudo = read('needs_sudo') === '1' || /needs_sudo:\s*1/.test(text);
  const permissionDenied = read('permission_denied') === '1' || needsSudo;
  const pidRepaired = read('pid_repaired') === '1';
  const upgradePending = read('upgrade_pending') === '1';
  return {
    running: Boolean(pid) && !stopped,
    stopped: stopped && !needsSudo,
    needsSudo,
    permissionDenied,
    pid,
    pidPath: read('pid_path'),
    pidRepaired,
    runningVersion: read('running_version'),
    diskVersion: read('disk_version'),
    runningExe: read('running_exe'),
    diskExe: read('disk_exe'),
    upgradePending,
    raw: text.trim(),
  };
}

/**
 * 从远端脚本内容读取协议版本；缺标记视为 1。
 * @param {string} scriptText
 * @returns {number}
 */
export function parseRemoteScriptVersion(scriptText) {
  const match = String(scriptText || '').match(/#\s*yuyan-nginx-script-version:\s*(\d+)/i);
  return match ? Number(match[1]) : 1;
}

/**
 * 拼装版本展示文案与 tooltip。
 * @param {{ version?: string, runningVersion?: string, diskVersion?: string, upgradePending?: boolean, versionDetectError?: string }} status
 * @returns {{ label: string, tooltip: string, upgradePending: boolean }}
 */
export function formatNginxVersionDisplay(status) {
  const running = String(status?.runningVersion || '').trim();
  const disk = String(status?.diskVersion || status?.version || '').trim();
  const detectError = String(status?.versionDetectError || '').trim();
  const upgradePending = Boolean(status?.upgradePending) || (running && disk && running !== disk);
  if (upgradePending && running && disk) {
    return {
      label: `运行 ${running} · 磁盘 ${disk} · 待平滑升级`,
      tooltip: `运行中的二进制版本为 ${running}，磁盘上的二进制版本为 ${disk}。可执行平滑切换（USR2 + QUIT）。`,
      upgradePending: true,
    };
  }
  const primary = running || disk || String(status?.version || '').trim();
  if (primary) {
    return { label: primary, tooltip: running && disk && running !== disk ? '' : `当前版本 ${primary}`, upgradePending: false };
  }
  return {
    label: '未知',
    tooltip: detectError || '未能探测到 Nginx 版本（无运行进程且无法从校验命令安全提取二进制，或执行 -v 失败）',
    upgradePending: false,
  };
}
