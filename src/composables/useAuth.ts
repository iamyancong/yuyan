import { ref, computed, onMounted, watch, readonly, nextTick } from 'vue';
import { message } from 'ant-design-vue';
import {
  setGitLabToken,
  setGitLabHost,
  getGitLabAuthStatus,
  getGitLabHost,
  updateGitLabClient,
  getCurrentUser as getGitLabCurrentUser,
} from '@/api/gitlab';
import type { GitLabUser } from '@/api/gitlab';

// 用户信息接口
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

// 认证状态接口
export interface AuthState {
  isAuthenticated: boolean;
  user: User | null;
  token: string | null;
  host: string;
  loading: boolean;
}

// 同步检查本地认证状态（快速，无网络请求）
const checkLocalAuth = () => {
  const token = localStorage.getItem('gitlab-token');
  const host = getGitLabHost();

  if (token && host) {
    return { token, host };
  }
  return null;
};

// ---- 全局单例状态（关键修复）----
// 将认证状态提升到模块作用域，确保所有调用 useAuth() 的地方共享同一份响应式数据
const initialLocalAuth = checkLocalAuth();
const authState = ref<AuthState>({
  isAuthenticated: false,
  user: null,
  token: initialLocalAuth?.token || null,
  host: initialLocalAuth?.host || import.meta.env.VITE_GITLAB_HOST || '',
  loading: !!initialLocalAuth,
});

let hasInitialized = false;
let hasSetupWatchers = false;

// 获取当前用户信息
const getCurrentUser = async (): Promise<User | null> => {
  try {
    const userData = await getGitLabCurrentUser();
    return {
      id: userData.id,
      username: userData.username,
      name: userData.name,
      avatar_url: userData.avatar_url,
      email: userData.email,
      web_url: userData.web_url,
      state: userData.state,
      created_at: userData.created_at,
    };
  } catch (error: any) {
    if (error.response?.status === 401) {
      // Token无效，清除认证状态
      await logout();
    }
    console.error('获取用户信息失败:', error);
    return null;
  }
};

// 登录函数（模块级，避免多实例）
const login = async (token: string, host: string): Promise<boolean> => {
  try {
    setGitLabToken(token);
    setGitLabHost(host);
    updateGitLabClient(host);

    authState.value.loading = true;

    const user = await getCurrentUser();

    if (user) {
      authState.value.isAuthenticated = true;
      authState.value.user = user;
      authState.value.token = token;
      authState.value.host = host;
      authState.value.loading = false;

      await nextTick();

      message.success(`欢迎回来，${user.name}！`);
      return true;
    } else {
      message.error('登录失败，令牌或服务器地址无效');
      await logout();
      return false;
    }
  } catch (error: any) {
    console.error('登录失败:', error);
    message.error(error?.response?.data?.message || error?.message || '登录失败');
    await logout();
    return false;
  }
};

// 登出函数（模块级，避免多实例）
const logout = async () => {
  setGitLabToken('');
  setGitLabHost('');

  authState.value.isAuthenticated = false;
  authState.value.user = null;
  authState.value.token = null;
  authState.value.host = import.meta.env.VITE_GITLAB_HOST || '';
  authState.value.loading = false;

  await nextTick();

  message.info('已退出登录');
};

// 检查认证状态
const checkAuth = async () => {
  const localAuth = checkLocalAuth();

  if (localAuth) {
    authState.value.loading = true;
    updateGitLabClient(localAuth.host);
    try {
      const user = await getCurrentUser();
      if (user) {
        authState.value.isAuthenticated = true;
        authState.value.user = user;
        authState.value.token = localAuth.token;
        authState.value.host = localAuth.host;
        authState.value.loading = false;
        await nextTick();
      } else {
        await logout();
      }
    } catch (error) {
      console.error('检查认证状态失败:', error);
      await logout();
    }
  } else {
    authState.value.isAuthenticated = false;
    authState.value.user = null;
    authState.value.token = null;
    authState.value.host = import.meta.env.VITE_GITLAB_HOST || '';
    authState.value.loading = false;
  }
};

// 初始化（仅一次）
const initAuth = async () => {
  if (hasInitialized) return;
  hasInitialized = true;
  await checkAuth();
};

// 设置一次性的全局监听器，派发登录/登出事件，供其他模块兜底联动
const setupWatchers = () => {
  if (hasSetupWatchers) return;
  hasSetupWatchers = true;

  watch(
    () => authState.value.isAuthenticated,
    async (newValue, oldValue) => {
      if (newValue === oldValue) return;
      const eventDetail = {
        isLoggedIn: newValue,
        timestamp: Date.now(),
        previousState: oldValue,
        currentState: newValue,
      };

      await nextTick();
      window.dispatchEvent(
        new CustomEvent('auth-state-changed', {
          detail: { ...eventDetail, action: newValue ? 'login' : 'logout' },
        })
      );
    }
  );
};

export const useAuth = () => {
  // 确保只初始化与监听一次
  setupWatchers();
  // 在微任务队列尽早同步一次本地认证状态
  nextTick(() => initAuth()).catch((e) => console.error('认证初始化失败:', e));

  // 计算属性
  const isLoggedIn = computed(() => authState.value.isAuthenticated);
  const currentUser = computed(() => authState.value.user);
  const userAvatar = computed(() => authState.value.user?.avatar_url || '');
  const userName = computed(() => authState.value.user?.name || authState.value.user?.username || '');
  const authLoading = computed(() => authState.value.loading);

  return {
    // 状态
    authState: readonly(authState),

    // 计算属性
    isLoggedIn,
    currentUser,
    userAvatar,
    userName,
    authLoading,

    // 方法
    login,
    logout,
    checkAuth,
    initAuth,
    getCurrentUser,
  };
};
