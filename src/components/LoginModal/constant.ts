/**
 * 登录弹窗常量配置与类型定义。
 */

export interface LoginFormState {
  token: string;
  host: string;
  rememberMe: boolean;
}

export interface LoginModalProps {
  visible: boolean;
}

export interface LoginModalEmits {
  (e: 'update:visible', value: boolean): void;
  (e: 'login-success'): void;
}

/** 访问令牌帮助提示说明 */
export const TOKEN_HELP_ALERT = {
  message: '获取访问令牌',
  description: '登录GitLab账户 → 用户设置 → 访问令牌 → 创建新令牌，选择 api、read_repository、write_repository 权限',
} as const;

/** 记住我安全警示提示文案 */
export const REMEMBER_ME_SECURITY_TIP = '凭据将保存至本地存储（30天有效）。公共或共享电脑请勿开启，避免凭据残留！' as const;
