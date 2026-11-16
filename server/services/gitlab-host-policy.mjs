/**
 * GitLab 地址白名单（#62）。
 * @description 服务端只向白名单内的 GitLab 地址发请求：网页头鉴权、v2 换票、提交信息补全、脚手架建仓/补标
 * 都在请求 GitLab 之前调用这里校验，避免客户端填一个假 GitLab 就能伪造身份，同时消除 SSRF 和服务端 Token 外发。
 *
 * 白名单来源（按优先级）：
 * 1. `YUYAN_ALLOWED_GITLAB_HOSTS`：逗号分隔，显式配置时只用它（`*` 表示不限制，仅用于本地调试）；
 * 2. 未显式配置时自动推导：`GITLAB_HOST`、`VITE_GITLAB_HOST`，以及数据库里已有账号登录过的 GitLab 地址
 *    （`identity_links.provider_host`），保证现网已登录用户升级后不被拦；
 * 3. 推导结果为空：服务绑定本机地址或作为桌面端内嵌服务时不限制（保持原行为）；
 *    绑定非本机地址时拒绝所有客户端 GitLab 地址并打日志，但不影响服务启动和已签发的会话。
 */

/** 白名单拒绝错误码 */
export const GITLAB_HOST_NOT_ALLOWED_CODE = 'gitlab_host_not_allowed';

/** 同一地址拒绝日志的最小间隔，避免刷屏 */
const REJECT_LOG_INTERVAL_MS = 60_000;

/** @type {Set<string>} 从数据库已有账号推导的地址 */
let learnedHosts = new Set();
/** @type {Map<string, number>} 地址 → 上次打拒绝日志时间 */
const rejectLogAt = new Map();

/**
 * 归一化 GitLab 地址：协议与主机小写、去默认端口、去账号密码/查询/锚点、去 `/api/v4` 后缀与尾斜杠。
 * @description 与 central-identity-service 的 normalizeGitlabHost 结果一致（accountId 依赖它）。
 * @param {unknown} value 地址
 * @returns {string} 归一化地址；非法或非 http(s) 返回空串
 */
export function normalizeGitlabHostValue(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(url.protocol)) return '';
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/api\/v4\/?$/i, '') || '/';
  return url.toString().replace(/\/+$/, '').toLowerCase();
}

/**
 * 解析白名单配置项：未写协议的条目同时允许 http 与 https。
 * @param {string} raw 逗号分隔的配置
 * @returns {{ hosts: string[], allowAll: boolean, invalid: string[] }}
 */
export function parseAllowedGitlabHosts(raw) {
  const hosts = new Set();
  const invalid = [];
  let allowAll = false;
  for (const item of String(raw ?? '').split(',')) {
    const entry = item.trim();
    if (!entry) continue;
    if (entry === '*') {
      allowAll = true;
      continue;
    }
    const candidates = /^[a-z][a-z0-9+.-]*:\/\//i.test(entry) ? [entry] : [`http://${entry}`, `https://${entry}`];
    const normalized = candidates.map(normalizeGitlabHostValue).filter(Boolean);
    if (!normalized.length) invalid.push(entry);
    normalized.forEach((host) => hosts.add(host));
  }
  return { hosts: [...hosts], allowAll, invalid };
}

/**
 * 判断服务是否只对本机开放（本机绑定或桌面端内嵌服务）。
 * @param {NodeJS.ProcessEnv} env 环境变量
 * @returns {boolean}
 */
function isLocalOnlyService(env) {
  if (String(env.IS_TAURI_SUBPROCESS || '') === 'true') return true;
  const bindHost = String(env.HOST || '127.0.0.1').trim().toLowerCase();
  return ['127.0.0.1', '::1', 'localhost'].includes(bindHost);
}

/**
 * 计算当前生效的白名单策略。
 * @param {Object} [options] 选项（测试用）
 * @param {NodeJS.ProcessEnv} [options.env] 环境变量
 * @param {Iterable<string>} [options.learned] 数据库推导的地址
 * @returns {{ mode: 'explicit'|'derived'|'open'|'closed'|'any', hosts: string[], sources: Record<string, string[]>, invalid: string[] }}
 */
export function resolveGitlabHostPolicy(options = {}) {
  const env = options.env || process.env;
  const learned = [...(options.learned || learnedHosts)];
  const explicitRaw = String(env.YUYAN_ALLOWED_GITLAB_HOSTS ?? '').trim();
  if (explicitRaw) {
    const parsed = parseAllowedGitlabHosts(explicitRaw);
    if (parsed.allowAll) return { mode: 'any', hosts: [], sources: { YUYAN_ALLOWED_GITLAB_HOSTS: ['*'] }, invalid: parsed.invalid };
    if (parsed.hosts.length) {
      return { mode: 'explicit', hosts: parsed.hosts, sources: { YUYAN_ALLOWED_GITLAB_HOSTS: parsed.hosts }, invalid: parsed.invalid };
    }
    // 显式配置但全部非法：按「推不出」处理，避免误开放
    return { mode: isLocalOnlyService(env) ? 'open' : 'closed', hosts: [], sources: {}, invalid: parsed.invalid };
  }

  const sources = {};
  const hosts = new Set();
  const add = (source, value) => {
    const normalized = normalizeGitlabHostValue(value);
    if (!normalized) return;
    hosts.add(normalized);
    (sources[source] ||= []).push(normalized);
  };
  add('GITLAB_HOST', env.GITLAB_HOST);
  add('VITE_GITLAB_HOST', env.VITE_GITLAB_HOST);
  learned.forEach((host) => add('identity_links', host));
  if (hosts.size) return { mode: 'derived', hosts: [...hosts], sources, invalid: [] };
  return { mode: isLocalOnlyService(env) ? 'open' : 'closed', hosts: [], sources: {}, invalid: [] };
}

/**
 * 设置从数据库已有账号推导出的 GitLab 地址（启动时调用一次）。
 * @param {Iterable<string>} hosts 地址列表
 */
export function setLearnedGitlabHosts(hosts) {
  learnedHosts = new Set([...(hosts || [])].map(normalizeGitlabHostValue).filter(Boolean));
}

/**
 * 取归一化地址的 origin（协议 + 主机 + 端口）。
 * @param {string} normalized 归一化地址
 * @returns {string}
 */
function toOrigin(normalized) {
  try {
    return new URL(normalized).origin.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 判断地址是否允许服务端请求。
 * @param {unknown} host 地址
 * @param {Object} [options] 同 resolveGitlabHostPolicy
 * @param {boolean} [options.matchOrigin] 只比较协议 + 主机 + 端口（仓库地址、提交信息补全等只取 origin 的场景）
 * @returns {boolean}
 */
export function isGitlabHostAllowed(host, options = {}) {
  const normalized = normalizeGitlabHostValue(host);
  if (!normalized) return false;
  const policy = resolveGitlabHostPolicy(options);
  if (policy.mode === 'any' || policy.mode === 'open') return true;
  if (policy.mode === 'closed') return false;
  if (options.matchOrigin) {
    const origin = toOrigin(normalized);
    return Boolean(origin) && policy.hosts.some((item) => toOrigin(item) === origin);
  }
  return policy.hosts.includes(normalized);
}

/**
 * 校验地址在白名单内，否则抛出 403 错误（不发出任何请求）。
 * @param {unknown} host 地址
 * @param {Object} [options] 选项
 * @param {string} [options.scene] 调用场景（用于日志）
 * @returns {string} 归一化地址
 */
export function assertGitlabHostAllowed(host, options = {}) {
  const normalized = normalizeGitlabHostValue(host);
  if (normalized && isGitlabHostAllowed(normalized, options)) return normalized;
  const policy = resolveGitlabHostPolicy(options);
  logRejectedHost(normalized || String(host ?? '').slice(0, 200), policy, options.scene);
  const error = new Error(
    policy.mode === 'closed'
      ? '服务端未配置允许的 GitLab 地址（YUYAN_ALLOWED_GITLAB_HOSTS），已拒绝本次 GitLab 身份校验，请联系管理员'
      : 'GitLab 地址不在服务端允许列表内，请使用公司 GitLab 地址登录'
  );
  error.code = GITLAB_HOST_NOT_ALLOWED_CODE;
  error.status = 403;
  throw error;
}

/**
 * 打印拒绝日志（同一地址每分钟最多一次）。
 * @param {string} host 被拒绝的地址
 * @param {{mode: string}} policy 策略
 * @param {string} [scene] 场景
 */
function logRejectedHost(host, policy, scene = '') {
  const key = `${scene}|${host}`;
  const nowMs = Date.now();
  if (nowMs - (rejectLogAt.get(key) || 0) < REJECT_LOG_INTERVAL_MS) return;
  rejectLogAt.set(key, nowMs);
  if (rejectLogAt.size > 1000) rejectLogAt.clear();
  const reason = policy.mode === 'closed' ? '白名单为空且服务绑定非本机地址' : '不在白名单内';
  console.warn(`[gitlab-host-policy] 已拒绝 GitLab 地址 ${host || '(空)'}（${reason}${scene ? `，场景：${scene}` : ''}），未向该地址发出请求`);
}

/**
 * 启动时打印生效的白名单与来源。
 * @param {Object} [options] 同 resolveGitlabHostPolicy
 * @returns {ReturnType<typeof resolveGitlabHostPolicy>}
 */
export function logGitlabHostPolicy(options = {}) {
  const policy = resolveGitlabHostPolicy(options);
  if (policy.invalid.length) {
    console.warn(`[gitlab-host-policy] YUYAN_ALLOWED_GITLAB_HOSTS 中有无法解析的条目，已忽略：${policy.invalid.join(', ')}`);
  }
  if (policy.mode === 'explicit') {
    console.log(`[gitlab-host-policy] GitLab 地址白名单（YUYAN_ALLOWED_GITLAB_HOSTS）：${policy.hosts.join(', ')}`);
  } else if (policy.mode === 'derived') {
    const detail = Object.entries(policy.sources).map(([source, hosts]) => `${source}=${hosts.join('|')}`).join('；');
    console.warn(`[gitlab-host-policy] 未配置 YUYAN_ALLOWED_GITLAB_HOSTS，已按现有配置推导白名单：${policy.hosts.join(', ')}（来源：${detail}）。建议显式配置该变量`);
  } else if (policy.mode === 'any') {
    console.warn('[gitlab-host-policy] YUYAN_ALLOWED_GITLAB_HOSTS=*：不限制 GitLab 地址，仅限本地调试使用');
  } else if (policy.mode === 'open') {
    console.log('[gitlab-host-policy] 本机模式且未配置 GitLab 地址白名单，不限制 GitLab 地址');
  } else {
    console.error('[gitlab-host-policy] 服务绑定非本机地址，但未配置 YUYAN_ALLOWED_GITLAB_HOSTS 且无法从 GITLAB_HOST / 已有账号推导：网页端登录与 App 换票将被拒绝，请配置该变量');
  }
  return policy;
}
