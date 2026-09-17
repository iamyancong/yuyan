/**
 * 登录表单逻辑管理 Composable。
 */

import { reactive, ref } from 'vue';
import { message } from 'ant-design-vue';
import { useAuth } from '@/composables/useAuth';
import { getRememberLoginPreference } from '@/services/secureAuth';
import type { LoginFormState } from '../constant';

/**
 * 管理登录表单输入状态、记住我偏好读取与登录提交。
 * @param emitSuccess - 登录成功事件触发回调
 * @param closeDialog - 关闭弹窗回调
 */
export function useLoginForm(emitSuccess: () => void, closeDialog: () => void) {
  const loading = ref(false);
  const { login: authLogin } = useAuth();

  const loginForm = reactive<LoginFormState>({
    token: '',
    host: import.meta.env.VITE_GITLAB_HOST || '',
    rememberMe: getRememberLoginPreference(),
  });

  /** 处理登录表单提交 */
  const handleLogin = async () => {
    const trimmedToken = loginForm.token.trim();
    const trimmedHost = loginForm.host.trim();

    if (!trimmedToken || !trimmedHost) {
      message.error('请输入完整的登录信息');
      return;
    }

    loading.value = true;
    try {
      const success = await authLogin(trimmedToken, trimmedHost, loginForm.rememberMe);
      if (success) {
        message.success('登录成功！');
        closeDialog();
        emitSuccess();
      } else {
        message.error('登录失败，请检查令牌和服务器地址');
      }
    } catch (error: any) {
      console.error('登录失败:', error);
      message.error(error?.response?.data?.message || error?.message || '登录失败');
    } finally {
      loading.value = false;
    }
  };

  /** 取消/关闭弹窗 */
  const handleCancel = () => {
    if (!loading.value) {
      closeDialog();
    }
  };

  return {
    loading,
    loginForm,
    handleLogin,
    handleCancel,
  };
}
