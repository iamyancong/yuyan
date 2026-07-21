import { computed, nextTick, readonly, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import {
  getCurrentUser as getGitLabCurrentUser,
  setGitLabHost,
  setGitLabToken,
  updateGitLabClient,
} from '@/api/gitlab';
import { exchangeGitlabIdentity, logoutCentralSession, refreshCentralSession } from '@/api/centralIdentity';
import {
  clearActiveSecureAccount,
  getDeviceIdentity,
  loadActiveSecureAccount,
  saveSecureAccount,
  signDeviceChallenge,
  type SecureAccountState,
} from '@/services/secureAuth';

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
  };
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

/** 在访问令牌临近过期时使用设备签名轮换。 */
async function refreshSecureSessionIfNeeded(state: SecureAccountState): Promise<SecureAccountState> {
  if (state.accessToken && Date.parse(state.accessExpiresAt) > Date.now() + 2 * 60_000) return state;
  if (!state.refreshToken || Date.parse(state.refreshExpiresAt) <= Date.now()) {
    return { ...state, accessToken: '', accessExpiresAt: '' };
  }
  const timestamp = Date.now();
  const nonce = crypto.randomUUID();
  const payload = `${state.deviceId}.${timestamp}.${nonce}.${state.refreshToken}`;
  try {
    const signed = await signDeviceChallenge(payload);
    const refreshed = await refreshCentralSession({
      deviceId: state.deviceId,
      refreshToken: state.refreshToken,
      timestamp,
      nonce,
      signature: signed.signature,
    });
    const next = { ...state, ...refreshed };
    await saveSecureAccount(next);
    return next;
  } catch (error: any) {
    if (error?.status === 401 || error?.code === 'session_expired') {
      return { ...state, accessToken: '', refreshToken: '', accessExpiresAt: '', refreshExpiresAt: '' };
    }
    return state;
  }
}

/** 在应用常驻和设备休眠恢复后提前轮换短期访问令牌。 */
async function maintainCentralSession() {
  const stored = await loadActiveSecureAccount(true).catch(() => null);
  if (!stored) return;
  const refreshed = await refreshSecureSessionIfNeeded(stored);
  const changed = refreshed.accessToken !== stored.accessToken
    || refreshed.refreshToken !== stored.refreshToken
    || refreshed.teamId !== stored.teamId
    || refreshed.role !== stored.role;
  if (!changed) return;
  await saveSecureAccount(refreshed);
  applySecureState(refreshed, authState.value.user);
  await syncAgentIdentity();
}

/** 只注册一次会话续期定时器。 */
function setupSessionRefresh() {
  if (hasSetupSessionRefresh || typeof window === 'undefined') return;
  hasSetupSessionRefresh = true;
  window.setInterval(() => void maintainCentralSession(), 60_000);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void maintainCentralSession();
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

/** GitLab PAT 登录并向中央注册当前设备。 */
const login = async (token: string, host: string): Promise<boolean> => {
  authState.value.loading = true;
  const normalizedHost = host.trim().replace(/\/+$/, '');
  try {
    setGitLabToken(token);
    setGitLabHost(normalizedHost);
    updateGitLabClient(normalizedHost);
    const user = await getCurrentUser();
    if (!user) throw new Error('GitLab 令牌或服务器地址无效');
    const device = await getDeviceIdentity();
    const session = await exchangeGitlabIdentity(normalizedHost, token, device);
    const secureState: SecureAccountState = {
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
    await saveSecureAccount(secureState);
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

/** 登出并清除中央会话、Agent 内存凭据和系统钥匙串账号状态。 */
const logout = async (silent = false) => {
  const secureState = await loadActiveSecureAccount().catch(() => null);
  if (secureState) await logoutCentralSession(secureState).catch(() => undefined);
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
  };
  await syncAgentIdentity();
  await nextTick();
  if (!silent) message.info('已退出登录');
};

/** 从系统钥匙串恢复当前设备的活动账号。 */
const checkAuth = async () => {
  authState.value.loading = true;
  const stored = await loadActiveSecureAccount(true).catch(() => null);
  if (!stored) {
    authState.value.loading = false;
    return false;
  }
  setGitLabToken(stored.gitlabToken);
  setGitLabHost(stored.gitlabHost);
  updateGitLabClient(stored.gitlabHost);
  const refreshed = await refreshSecureSessionIfNeeded(stored);
  const remoteUser = await getCurrentUser();
  applySecureState(refreshed, remoteUser);
  await syncAgentIdentity();
  await nextTick();
  return true;
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

/** 共享认证单例。 */
export const useAuth = () => {
  setupWatchers();
  setupSessionRefresh();
  nextTick(() => initAuth()).catch((error) => console.error('认证初始化失败:', error));
  return {
    authState: readonly(authState),
    isLoggedIn: computed(() => authState.value.isAuthenticated),
    currentUser: computed(() => authState.value.user),
    userAvatar: computed(() => authState.value.user?.avatar_url || ''),
    userName: computed(() => authState.value.user?.name || authState.value.user?.username || ''),
    authLoading: computed(() => authState.value.loading),
    login,
    logout,
    checkAuth,
    initAuth,
    getCurrentUser,
  };
};
