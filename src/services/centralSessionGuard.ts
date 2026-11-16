/**
 * 中央会话失效守卫（纯逻辑，无框架依赖）。
 * @description 中央 v2 鉴权中间件在访问令牌不被认可时返回 `401 + session_invalid`
 * （例如 App 升级后切到新中央服务器，本地仍保存旧服务器签发的令牌）。
 * 这种失效重试无意义，需要由认证层清理本地会话并引导重新登录。
 * - 只认「HTTP 401 且业务码 session_invalid」，部署目标服务器、Agent Gateway、网页 PAT 的鉴权失败都不匹配；
 * - 同一时间只处理一次，并发失败的请求共享同一轮处理，避免重复提示/重复登出；
 * - 带上发出请求时使用的访问令牌，处理器据此忽略重新登录后才返回的旧请求。
 */

/** 中央 v2 鉴权失败业务码。 */
export const CENTRAL_SESSION_INVALID_CODE = 'session_invalid';

/** 中央会话失效处理器，参数为发出失败请求时使用的访问令牌。 */
export type CentralSessionInvalidHandler = (usedAccessToken: string) => void | Promise<void>;

let handler: CentralSessionInvalidHandler | null = null;
let activeHandling: Promise<void> | null = null;

/**
 * 判断错误是否为中央会话失效（HTTP 401 + session_invalid）。
 * @param error axios 归一化错误或 requestCentral 抛出的错误
 * @returns 是否为中央会话失效
 */
export function isCentralSessionInvalidError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as Record<string, any>;
  const status = Number(err.response?.status ?? err.status);
  if (status !== 401) return false;
  const body = err.response?.data;
  const nestedCode = body && typeof body === 'object' && body.error && typeof body.error === 'object' ? body.error.code : undefined;
  const code = err.apiCode ?? nestedCode ?? err.code;
  return code === CENTRAL_SESSION_INVALID_CODE;
}

/**
 * 从请求头中提取 Bearer 访问令牌。
 * @param headers axios/fetch 请求头（普通对象或带 get 方法的 Headers）
 * @returns 访问令牌，没有则为空串
 */
export function extractBearerToken(headers: unknown): string {
  if (!headers || typeof headers !== 'object') return '';
  const source = headers as Record<string, any>;
  let value: unknown = '';
  if (typeof source.get === 'function') {
    value = source.get('Authorization') ?? source.get('authorization');
  }
  if (!value) value = source.Authorization ?? source.authorization;
  const match = /^Bearer\s+(.+)$/i.exec(String(value || '').trim());
  return match ? match[1].trim() : '';
}

/** 认证层判断是否需要清会话时的输入。 */
export interface CentralSessionInvalidContext {
  /** 是否为桌面端（网页端不持有中央访问令牌）。 */
  isDesktop: boolean;
  /** 当前是否已登录。 */
  isAuthenticated: boolean;
  /** 当前保存的访问令牌。 */
  currentAccessToken: string;
  /** 失败请求携带的访问令牌。 */
  usedAccessToken: string;
}

/**
 * 判断一次中央会话失效是否应清会话并引导重新登录（纯函数）。
 * @description 只有失败请求用的正是当前令牌才处理：未登录、网页端、
 * 或重新登录后才返回的旧令牌请求都忽略，避免误登出新会话和登录循环。
 * @param context 判断输入
 * @returns 是否需要清会话并打开登录
 */
export function shouldResetForCentralSessionInvalid(context: CentralSessionInvalidContext): boolean {
  return Boolean(
    context.isDesktop
    && context.isAuthenticated
    && context.currentAccessToken
    && context.usedAccessToken === context.currentAccessToken
  );
}

/** 中央会话失效后的处理动作。 */
export type CentralSessionInvalidAction = 'ignore' | 'reestablish' | 'relogin';

/** 静默续期决策输入。 */
export interface CentralSessionRecoveryContext extends CentralSessionInvalidContext {
  /** 本地是否保存了可用于重新换取会话的 GitLab 凭据。 */
  hasGitlabCredential: boolean;
  /** 已经静默续期过的令牌（包括尝试过的旧令牌与静默换来的新令牌）。 */
  silentRecoveryTokens: ReadonlySet<string>;
}

/**
 * 决定中央会话失效后的动作（纯函数）。
 * @description
 * - 不该处理（网页端、未登录、迟到的旧令牌请求）→ ignore；
 * - 有 GitLab 凭据且该令牌从未静默续期过 → reestablish（先静默换新会话）；
 * - 否则（无凭据、已试过、静默换来的新令牌立刻又失效）→ relogin，避免无限续期循环。
 * @param context 决策输入
 * @returns 处理动作
 */
export function decideCentralSessionInvalidAction(context: CentralSessionRecoveryContext): CentralSessionInvalidAction {
  if (!shouldResetForCentralSessionInvalid(context)) return 'ignore';
  if (!context.hasGitlabCredential) return 'relogin';
  if (context.silentRecoveryTokens.has(context.usedAccessToken)) return 'relogin';
  return 'reestablish';
}

/**
 * 注册中央会话失效处理器（全局只保留一个）。
 * @param next 处理器
 * @returns 注销方法
 */
export function registerCentralSessionInvalidHandler(next: CentralSessionInvalidHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/**
 * 上报一次请求失败；仅在中央会话失效且请求确实携带了访问令牌时交给处理器。
 * @param error 请求错误
 * @param usedAccessToken 发出请求时使用的访问令牌
 * @returns 是否识别为中央会话失效
 */
export function reportCentralSessionInvalid(error: unknown, usedAccessToken: string): boolean {
  if (!isCentralSessionInvalidError(error)) return false;
  if (!usedAccessToken || !handler || activeHandling) return true;
  const current = handler;
  const handling = Promise.resolve()
    .then(() => current(usedAccessToken))
    .catch((handlerError) => console.warn('[CentralSession] 会话失效处理失败', handlerError))
    .finally(() => {
      if (activeHandling === handling) activeHandling = null;
    });
  activeHandling = handling;
  return true;
}

/**
 * 等待当前这一轮会话失效处理结束（测试与调用方需要顺序保证时使用）。
 * @returns 处理结束
 */
export async function waitForCentralSessionInvalidHandling(): Promise<void> {
  if (activeHandling) await activeHandling;
}
