import { computed, nextTick, readonly, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import {
  getCurrentUser as getGitLabCurrentUser,
  setGitLabHost,
  setGitLabToken,
  updateGitLabClient,
} from '@/api/gitlab';
import { exchangeGitlabIdentity, logoutCentralSession, refreshCentralSession } from '@/api/centralIdentity';
import { getCentralBackupAccess } from '@/api/deploy';
import { decideCentralSessionInvalidAction, registerCentralSessionInvalidHandler } from '@/services/centralSessionGuard';
import { classifyCentralAuthError, createSerialTaskQueue, recoverCentralSession } from '@/services/centralSessionRecovery';
import { refreshCentralData } from '@/services/centralDataRefresh';
import {
  clearActiveSecureAccount,
  getCachedSecureAccount,
  getDeviceIdentity,
  loadActiveSecureAccount,
  saveSecureAccount,
  signDeviceChallenge,
  WEB_ACCOUNT_LOCAL_KEY,
  type SecureAccountState,
} from '@/services/secureAuth';
import { isTauri } from '@/utils/env';
import { waitForCondition } from '@/utils/waitForCondition';
import {
  classifyGitlabUserError,
  decideCheckAuthRemoteAction,
  shouldAbortAuthGeneration,
  type RemoteUserKind,
  type CheckAuthRemoteDecision,
} from './authCheckPolicy';

/** 雨燕展示用户。 */
export interface User {
  id: number;
  username: string;
  name: string;
  avatar_url: string;
  email?: string;
  web_url: string;
  state: string;
  created_at: string;
}

/** 当前账号与设备认证状态。 */
export interface AuthState {
  isAuthenticated: boolean;
  user: User | null;
  token: string | null;
  host: string;
  loading: boolean;
  accountId: string;
  deviceId: string;
  teamId: string;
  role: 'viewer' | 'operator' | 'admin' | '';
  accessToken: string;
  accessExpiresAt: string;
  centralSessionReady: boolean;
  /** 当前会话是否在系统管理员白名单中（用于隐藏「中央灾备」入口）。 */
  isSystemAdmin: boolean;
}

const defaultHost = import.meta.env.VITE_GITLAB_HOST || '';
const authState = ref<AuthState>({
  isAuthenticated: false,
  user: null,
  token: null,
  host: defaultHost,
  loading: true,
  accountId: '',
  deviceId: '',
  teamId: '',
  role: '',
  accessToken: '',
  accessExpiresAt: '',
  centralSessionReady: false,
  isSystemAdmin: false,
});

let hasInitialized = false;
let hasSetupWatchers = false;
let hasSetupSessionRefresh = false;

/** 把 GitLab 用户响应收敛为页面使用的字段。 */
function mapGitlabUser(user: any): User {
  return {
    id: Number(user.id),
    username: String(user.username || ''),
    name: String(user.name || user.username || ''),
    avatar_url: String(user.avatar_url || user.avatarUrl || ''),
    email: user.email,
    web_url: String(user.web_url || ''),
    state: String(user.state || 'active'),
    created_at: String(user.created_at || ''),
  };
}

/** 将安全状态映射到 Vue 单例，不复制刷新令牌。 */
function applySecureState(state: SecureAccountState, user?: User | null) {
  authState.value = {
    isAuthenticated: true,
    user: user || {
      id: state.gitlabUserId,
      username: state.gitlabUsername,
      name: state.gitlabDisplayName || state.gitlabUsername,
      avatar_url: state.gitlabAvatarUrl,
      web_url: '',
      state: 'active',
      created_at: '',
    },
    token: state.gitlabToken,
    host: state.gitlabHost,
    loading: false,
    accountId: state.accountId,
    deviceId: state.deviceId || '',
    teamId: state.teamId,
    role: state.role,
    accessToken: state.accessToken,
    accessExpiresAt: state.accessExpiresAt,
    centralSessionReady: Boolean(state.accessToken && state.teamId && Date.parse(state.accessExpiresAt) > Date.now()),
    isSystemAdmin: Boolean(authState.value.isSystemAdmin),
  };
}

/** 向中央服务探测当前会话是否为系统管理员；失败时按非管理员处理。 */
async function refreshSystemAdminFlag() {
  if (!authState.value.isAuthenticated) {
    authState.value.isSystemAdmin = false;
    return;
  }
  try {
    const access = await getCentralBackupAccess();
    if (!authState.value.isAuthenticated) return;
    authState.value.isSystemAdmin = Boolean(access?.isSystemAdmin);
  } catch {
    if (authState.value.isAuthenticated) {
      authState.value.isSystemAdmin = false;
    }
  }
}

/** 通知 Agent Gateway 立即清空或切换身份，避免内存残留旧 PAT。 */
async function syncAgentIdentity() {
  try {
    const { syncAgentRuntimeSettings } = await import('@/api/agent');
    await syncAgentRuntimeSettings();
  } catch {
    // 本地 Node 尚未就绪时由 AI 控制中心和全局审批宿主稍后重试。
  }
}

/**
 * 所有中央会话续期（定时刷新、启动恢复、失效恢复）的串行队列。
 * @description refresh 会让旧访问令牌立即失效、换票会吊销设备上全部会话，并发执行会互相作废刚换到的令牌。
 */
const sessionQueue = createSerialTaskQueue();

/**
 * 用 GitLab PAT 重新换取中央设备会话（会吊销该设备旧会话），失败时抛出带 status/code 的错误。
 * @param state - 当前安全账号状态
 * @returns 新会话状态（未保存）
 */
async function exchangeSessionWithGitlab(state: SecureAccountState): Promise<SecureAccountState> {
  if (!isTauri()) throw new Error('设备会话仅在雨燕桌面端可用');
  const device = await getDeviceIdentity();
  const session = await exchangeGitlabIdentity(state.gitlabHost, state.gitlabToken, device);
  return {
    ...state,
    accountId: session.accountId,
    deviceId: session.deviceId,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    teamId: session.teamId,
    role: session.role,
    accessExpiresAt: session.accessExpiresAt,
    refreshExpiresAt: session.refreshExpiresAt,
  };
}

/**
 * 用设备签名 + refresh 令牌轮换会话（不吊销其他会话），失败时抛错。
 * @param state - 当前安全账号状态
 * @returns 新会话状态（未保存）
 */
async function rotateSessionWithRefreshToken(state: SecureAccountState): Promise<SecureAccountState> {
  const timestamp = Date.now();
  const nonce = crypto.randomUUID();
  const payload = `${state.deviceId}.${timestamp}.${nonce}.${state.refreshToken}`;
  const signed = await signDeviceChallenge(payload);
  const refreshed = await refreshCentralSession({
    deviceId: state.deviceId,
    refreshToken: state.refreshToken,
    timestamp,
    nonce,
    signature: signed.signature,
  });
  return { ...state, ...refreshed };
}

/**
 * 使用平台安全存储中保存的 GitLab PAT 重新建立中央设备会话。
 * @description 刷新令牌过期或被服务端撤销时无需用户重新登录；身份被明确拒绝时保存只读兼容状态，
 * 避免后续请求继续携带已经失效的访问令牌；网络、超时等临时错误保持原状态，下次再试。
 * @param state - 当前安全账号状态
 * @returns 已恢复、已降级或保持原样的安全账号状态
 */
async function reestablishCentralSession(state: SecureAccountState): Promise<SecureAccountState> {
  const fallbackState: SecureAccountState = {
    ...state,
    accessToken: '',
    refreshToken: '',
    accessExpiresAt: '',
    refreshExpiresAt: '',
  };
  if (!isTauri() || !state.gitlabHost || !state.gitlabToken) return fallbackState;

  try {
    const next = await exchangeSessionWithGitlab(state);
    await saveSecureAccount(next);
    return next;
  } catch (error) {
    if (classifyCentralAuthError(error) === 'transient') return state;
    await saveSecureAccount(fallbackState);
    return fallbackState;
  }
}

/** 在访问令牌临近过期时使用设备签名轮换。调用方需在 sessionQueue 内执行。 */
async function refreshSecureSessionIfNeeded(state: SecureAccountState): Promise<SecureAccountState> {
  if (state.accessToken && Date.parse(state.accessExpiresAt) > Date.now() + 2 * 60_000) return state;
  if (!state.refreshToken || Date.parse(state.refreshExpiresAt) <= Date.now()) {
    return reestablishCentralSession(state);
  }
  try {
    const next = await rotateSessionWithRefreshToken(state);
    await saveSecureAccount(next);
    return next;
  } catch (error: any) {
    if (classifyCentralAuthError(error) === 'rejected') {
      return reestablishCentralSession(state);
    }
    return state;
  }
}

/** 在应用常驻和设备休眠恢复后提前轮换短期访问令牌。 */
function maintainCentralSession() {
  return sessionQueue.run(async () => {
    const stored = await loadActiveSecureAccount(true).catch(() => null);
    if (!stored) return;
    const refreshed = await refreshSecureSessionIfNeeded(stored);
    const changed = refreshed.accessToken !== stored.accessToken
      || refreshed.refreshToken !== stored.refreshToken
      || refreshed.teamId !== stored.teamId
      || refreshed.role !== stored.role;
    if (!changed) return;
    await saveSecureAccount(refreshed);
    /** 续期期间已登出：不把会话写回界面。 */
    if (!authState.value.isAuthenticated) return;
    applySecureState(refreshed, authState.value.user);
    await syncAgentIdentity();
  });
}

/** 只注册一次会话续期定时器。 */
function setupSessionRefresh() {
  if (hasSetupSessionRefresh || typeof window === 'undefined') return;
  hasSetupSessionRefresh = true;
  window.setInterval(() => void maintainCentralSession().catch(() => undefined), 60_000);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void maintainCentralSession().catch(() => undefined);
  });
}

/** 获取当前 GitLab 用户，401 会触发安全登出。 */
const getCurrentUser = async (): Promise<User | null> => {
  try {
    return mapGitlabUser(await getGitLabCurrentUser());
  } catch (error: any) {
    if (error.response?.status === 401) await logout(true);
    return null;
  }
};

/** 构建不包含设备与中央令牌的网页标签页会话。 */
function createWebSecureState(token: string, host: string, user: User): SecureAccountState {
  return {
    accountId: `web:${host}:${user.id}`,
    deviceId: '',
    gitlabHost: host,
    gitlabUserId: user.id,
    gitlabUsername: user.username,
    gitlabDisplayName: user.name,
    gitlabAvatarUrl: user.avatar_url,
    gitlabToken: token,
    accessToken: '',
    refreshToken: '',
    teamId: '',
    role: '',
    accessExpiresAt: '',
    refreshExpiresAt: '',
  };
}

/**
 * 失效恢复换来的访问令牌 → 换到的时间。
 * @description 恢复换来的新令牌若在 CENTRAL_RECOVERY_LOOP_WINDOW_MS 内又被判失效，直接走重新登录，杜绝循环；
 * 超过窗口后的失效（正常轮换窗口）照常恢复。登录、登出时清空。
 */
const recoveredTokens = new Map<string, number>();

/** GitLab PAT 登录；桌面端注册设备，网页端建立会话并按需持久化。 */
const login = async (token: string, host: string, rememberMe = false): Promise<boolean> => {
  authState.value.loading = true;
  recoveredTokens.clear();
  const normalizedHost = host.trim().replace(/\/+$/, '');
  try {
    setGitLabToken(token);
    setGitLabHost(normalizedHost);
    updateGitLabClient(normalizedHost);
    const user = await getCurrentUser();
    if (!user) throw new Error('GitLab 令牌或服务器地址无效');
    if (!isTauri()) {
      const webState = createWebSecureState(token, normalizedHost, user);
      await saveSecureAccount(webState, rememberMe);
      applySecureState(webState, user);
      await nextTick();
      message.success(`欢迎回来，${user.name}！`);
      return true;
    }
    /** 与定时刷新、失效恢复串行：避免旧会话的续期在登录换票后把新会话吊销或覆盖。 */
    const secureState = await sessionQueue.run(async () => {
      const device = await getDeviceIdentity();
      const session = await exchangeGitlabIdentity(normalizedHost, token, device);
      const next: SecureAccountState = {
        accountId: session.accountId,
        deviceId: session.deviceId,
        gitlabHost: normalizedHost,
        gitlabUserId: user.id,
        gitlabUsername: user.username,
        gitlabDisplayName: user.name,
        gitlabAvatarUrl: user.avatar_url,
        gitlabToken: token,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        teamId: session.teamId,
        role: session.role,
        accessExpiresAt: session.accessExpiresAt,
        refreshExpiresAt: session.refreshExpiresAt,
      };
      await saveSecureAccount(next);
      return next;
    });
    applySecureState(secureState, user);
    await syncAgentIdentity();
    await nextTick();
    message.success(`欢迎回来，${user.name}！`);
    return true;
  } catch (error) {
    setGitLabToken('');
    setGitLabHost(defaultHost);
    authState.value.loading = false;
    throw error;
  }
};

let authGeneration = 0;

/** 获取远程 GitLab 用户信息并对异常分类。 */
const fetchRemoteUser = async (): Promise<
  | { kind: 'ok'; user: User }
  | { kind: 'unauthorized' }
  | { kind: 'unavailable' }
> => {
  try {
    return { kind: 'ok', user: mapGitlabUser(await getGitLabCurrentUser()) };
  } catch (error) {
    return { kind: classifyGitlabUserError(error) };
  }
};

/** 登出选项。 */
interface LogoutOptions {
  /** 中央已判定会话失效时跳过远端注销，避免再用失效令牌请求中央。 */
  skipRemoteRevoke?: boolean;
}

/** 登出并清除中央会话、Agent 内存凭据和平台安全存储账号状态。 */
const logout = async (silent = false, options: LogoutOptions = {}) => {
  ++authGeneration;
  recoveredTokens.clear();
  const secureState = await loadActiveSecureAccount().catch(() => null);
  if (secureState && !options.skipRemoteRevoke) await logoutCentralSession(secureState).catch(() => undefined);
  await clearActiveSecureAccount().catch(() => undefined);
  setGitLabToken('');
  setGitLabHost(defaultHost);
  authState.value = {
    isAuthenticated: false,
    user: null,
    token: null,
    host: defaultHost,
    loading: false,
    accountId: '',
    deviceId: '',
    teamId: '',
    role: '',
    accessToken: '',
    accessExpiresAt: '',
    centralSessionReady: false,
    isSystemAdmin: false,
  };
  // 再加一代，丢掉登出过程中新启动、但仍拿着旧存储快照的 checkAuth
  ++authGeneration;
  await syncAgentIdentity();
  await nextTick();
  if (!silent) message.info('已退出登录');
};

/** 会话过期提示的固定 key，重复触发时覆盖而不是叠加。 */
const SESSION_EXPIRED_MESSAGE_KEY = 'yuyan-central-session-expired';

/** 静默续期被明确拒绝时：清会话、提示并打开登录弹窗。 */
async function resetToLogin(reason = '') {
  await logout(true, { skipRemoteRevoke: true });
  message.warning({ content: reason ? `登录已失效：${reason}，请重新登录` : '登录已过期，请重新登录', key: SESSION_EXPIRED_MESSAGE_KEY });
  window.dispatchEvent(new CustomEvent('show-login-modal'));
}

/** GitLab 地址白名单拒绝提示的固定 key。 */
const GITLAB_HOST_REJECTED_MESSAGE_KEY = 'yuyan-gitlab-host-not-allowed';

/**
 * 中央判定会话失效（401 session_invalid）后的处理。
 * @description 访问令牌每 15 分钟由定时器轮换一次，服务端轮换后旧令牌立即失效，轮换落盘前仍在路上的请求会拿到 401，
 * 这是正常现象。所以先等进行中的续期落盘：令牌已变 → 忽略；否则在串行队列里先 refresh、被拒才用 GitLab 凭据换票。
 * 只有身份被明确拒绝（GitLab 令牌失效、设备被撤销等）才清会话并打开登录弹窗；
 * 网络/5xx 等临时错误保持登录；GitLab 地址不在服务端白名单时给出明确提示，不当作登录过期。
 * 未登录、网页端或重新登录后才返回的旧请求都直接忽略，避免误登出和循环。
 * @param usedAccessToken 失败请求携带的访问令牌
 */
async function handleCentralSessionInvalid(usedAccessToken: string) {
  if (!isTauri() || !authState.value.isAuthenticated || !usedAccessToken) return;
  /** 等定时刷新/启动恢复把新令牌落盘，再判断失败请求是不是轮换窗口里的旧请求。 */
  await sessionQueue.idle();
  const action = decideCentralSessionInvalidAction({
    isDesktop: isTauri(),
    isAuthenticated: authState.value.isAuthenticated,
    currentAccessToken: getCachedSecureAccount()?.accessToken || authState.value.accessToken,
    usedAccessToken,
    recoveredAt: recoveredTokens.get(usedAccessToken),
  });
  if (action === 'ignore') return;
  if (action === 'relogin') {
    await resetToLogin();
    return;
  }

  const generation = authGeneration;
  const outcome = await sessionQueue.run(() => recoverCentralSession<SecureAccountState>(usedAccessToken, {
    loadStored: () => loadActiveSecureAccount(true).catch(() => null),
    refresh: rotateSessionWithRefreshToken,
    exchange: exchangeSessionWithGitlab,
    save: (state) => saveSecureAccount(state),
  }));
  /** 恢复期间用户已登出或重新登录：不覆盖新的登录状态；若刚写入的会话残留在已登出的存储里则清掉。 */
  if (generation !== authGeneration || !authState.value.isAuthenticated) {
    if (outcome.kind === 'recovered' && !authState.value.isAuthenticated
      && getCachedSecureAccount()?.accessToken === outcome.state.accessToken) {
      await clearActiveSecureAccount().catch(() => undefined);
    }
    return;
  }

  switch (outcome.kind) {
    case 'rotated': {
      /** 令牌已由其他续期换掉：界面若还停在旧令牌，同步到存储里的最新会话。 */
      const latest = getCachedSecureAccount();
      if (latest?.accessToken && latest.accessToken !== authState.value.accessToken) {
        applySecureState(latest, authState.value.user);
        await syncAgentIdentity();
      }
      return;
    }
    case 'recovered':
      recoveredTokens.set(outcome.state.accessToken, Date.now());
      applySecureState(outcome.state, authState.value.user);
      /** 与正常登录一致：把新令牌同步给本地 Agent Gateway / MCP。 */
      await syncAgentIdentity();
      await nextTick();
      /** 重新拉取当前页面的中央数据（部署中心等注册了刷新处理器的页面），不弹提示。 */
      void refreshCentralData().catch(() => undefined);
      return;
    case 'transient':
      /** 网络抖动、服务重启等：保持登录，下一次请求或定时器会再续期。 */
      console.warn('[CentralSession] 会话续期暂时失败，保持登录稍后重试', outcome.error);
      return;
    case 'host_not_allowed': {
      /** 服务端白名单拒绝（#62）：不是登录过期。清掉失效的中央令牌避免反复 401，保留登录，管理员配置后定时器自动恢复。 */
      const stored = getCachedSecureAccount();
      if (stored) {
        const degraded = { ...stored, accessToken: '', refreshToken: '', accessExpiresAt: '', refreshExpiresAt: '' };
        await saveSecureAccount(degraded).catch(() => undefined);
        applySecureState(degraded, authState.value.user);
        await syncAgentIdentity();
      }
      message.error({
        content: `雨燕服务端未允许当前 GitLab 地址（${stored?.gitlabHost || authState.value.host}），暂时无法连接中央服务。`
          + '请联系管理员在服务端配置 YUYAN_ALLOWED_GITLAB_HOSTS，配置后无需重新登录即可自动恢复。',
        key: GITLAB_HOST_REJECTED_MESSAGE_KEY,
        duration: 8,
      });
      return;
    }
    case 'rejected':
    default: {
      const err = (outcome as { error?: { code?: string; message?: string } }).error;
      const showReason = err?.code === 'device_revoked' || err?.code === 'device_key_mismatch';
      await resetToLogin(showReason ? String(err?.message || '') : '');
    }
  }
}

let hasSetupSessionInvalidGuard = false;

/** 只注册一次中央会话失效处理器。 */
function setupSessionInvalidGuard() {
  if (hasSetupSessionInvalidGuard || typeof window === 'undefined') return;
  hasSetupSessionInvalidGuard = true;
  registerCentralSessionInvalidHandler(handleCentralSessionInvalid);
}

/** 从平台安全存储恢复当前设备的活动账号。 */
const checkAuth = async () => {
  const gen = ++authGeneration;
  authState.value.loading = true;
  try {
    const stored = await loadActiveSecureAccount(true).catch(() => null);
    if (shouldAbortAuthGeneration(gen, authGeneration)) return false;
    if (!stored) return false;

    setGitLabToken(stored.gitlabToken);
    setGitLabHost(stored.gitlabHost);
    updateGitLabClient(stored.gitlabHost);

    /** 与定时刷新、失效恢复串行，并在队列内重新读取最新会话，避免用已轮换的 refresh 令牌触发换票。 */
    const refreshed = await sessionQueue.run(async () => {
      const latest = await loadActiveSecureAccount(true).catch(() => null);
      return refreshSecureSessionIfNeeded(latest || stored);
    });
    if (shouldAbortAuthGeneration(gen, authGeneration)) return false;

    const remote = await fetchRemoteUser();
    if (shouldAbortAuthGeneration(gen, authGeneration)) return false;

    const decision = decideCheckAuthRemoteAction(remote.kind);
    if (decision.action === 'logout') {
      await logout(true);
      return false;
    }

    // apply-remote → 用远程用户；apply-cached → 省略远程用户做离线恢复
    applySecureState(refreshed, decision.action === 'apply-remote' && remote.kind === 'ok' ? remote.user : null);
    await syncAgentIdentity();
    await nextTick();
    return true;
  } finally {
    if (!shouldAbortAuthGeneration(gen, authGeneration)) {
      authState.value.loading = false;
    }
  }
};

/** 只初始化一次安全认证。 */
const initAuth = async () => {
  if (hasInitialized) return;
  hasInitialized = true;
  await checkAuth();
};

/** 派发全局账号切换事件。 */
const setupWatchers = () => {
  if (hasSetupWatchers) return;
  hasSetupWatchers = true;
  watch(
    () => `${authState.value.isAuthenticated}|${authState.value.accountId}|${authState.value.accessToken}`,
    async () => {
      if (!authState.value.isAuthenticated) {
        authState.value.isSystemAdmin = false;
        return;
      }
      await refreshSystemAdminFlag();
    },
  );
  watch(
    () => `${authState.value.accountId}|${authState.value.teamId}|${authState.value.isAuthenticated}`,
    async (current, previous) => {
      if (current === previous) return;
      await nextTick();
      window.dispatchEvent(new CustomEvent('auth-state-changed', {
        detail: {
          isLoggedIn: authState.value.isAuthenticated,
          accountId: authState.value.accountId,
          deviceId: authState.value.deviceId,
          teamId: authState.value.teamId,
          action: authState.value.isAuthenticated ? 'login' : 'logout',
          timestamp: Date.now(),
        },
      }));
    }
  );
};

let hasSetupStorageSync = false;

/** 监听浏览器跨标签页本地持久化账号状态变更（多 Tab 同步登出与登录恢复）。 */
const setupStorageSync = () => {
  if (hasSetupStorageSync || typeof window === 'undefined' || isTauri()) return;
  hasSetupStorageSync = true;
  window.addEventListener('storage', (event) => {
    if (event.key === WEB_ACCOUNT_LOCAL_KEY) {
      if (!event.newValue && authState.value.isAuthenticated) {
        // 其他标签页退出了登录，当前标签页同步退出
        logout(true).catch(() => undefined);
      } else if (event.newValue && !authState.value.isAuthenticated) {
        // 其他标签页通过「记住我」登录成功，当前标签页同步恢复
        checkAuth().catch(() => undefined);
      }
    }
  });
};

/** 共享认证单例。 */
export const useAuth = () => {
  setupWatchers();
  setupSessionRefresh();
  setupSessionInvalidGuard();
  setupStorageSync();
  nextTick(() => initAuth()).catch((error) => console.error('认证初始化失败:', error));
  return {
    authState: readonly(authState),
    isLoggedIn: computed(() => authState.value.isAuthenticated),
    currentUser: computed(() => authState.value.user),
    userAvatar: computed(() => authState.value.user?.avatar_url || ''),
    userName: computed(() => authState.value.user?.name || authState.value.user?.username || ''),
    isSystemAdmin: computed(() => authState.value.isSystemAdmin),
    authLoading: computed(() => authState.value.loading),
    login,
    logout,
    checkAuth,
    initAuth,
    getCurrentUser,
  };
};

/**
 * 等待首次认证初始化完成。
 * @description watch 驱动，替代各页面自行实现的「最多 5 秒、100ms 步进」忙等轮询。
 * 带超时兜底：中央服务 refresh 走裸 fetch 无超时，若服务端挂起，无限等待会把页面卡死——
 * 超时后按「未登录」降级继续（与旧忙等实现的 5s 上限语义一致，上限放宽至覆盖 GitLab 15s 请求超时）。
 * @param timeoutMs 超时毫秒数，默认 15s
 * @returns 初始化完成（或超时降级）后 resolve
 */
export const waitForAuthReady = async (timeoutMs = 15_000): Promise<void> => {
  await waitForCondition(() => !authState.value.loading, timeoutMs);
};

export {
  classifyGitlabUserError,
  decideCheckAuthRemoteAction,
  shouldAbortAuthGeneration,
  type RemoteUserKind,
  type CheckAuthRemoteDecision,
};
