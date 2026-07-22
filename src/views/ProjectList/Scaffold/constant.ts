export const SCAFFOLD_TIPS = {
  appName: '微应用的英文标识，用于仓库名/包名/容器名前缀。仅小写字母、数字和短横线，必须以字母开头，如 data-service',
  appNameZh: '微应用的用户友好中文名称，将显示在菜单和页面标题中，支持中文、英文、数字和空格',
  port: '本地开发端口号，将写入脚手架项目的 devServer 配置，范围 1-65535，避免与已占用端口冲突',
  activeRule:
    '激活路由前缀，也是子应用在模板中的 VITE_SUB_APP_NAME 来源（去掉开头/）。必须以 / 开头且仅一段路径；允许驼峰或短横线命名，如 /dmDataSource、/data-service、/data-source-v3；不得包含多个 /、反斜杠等',
  apiBase: '前端请求统一前缀（baseURL）。用于 axios 基础路径和 Vite 代理匹配，通常填写 /api',
  proxyTarget: '开发阶段通过 Vite 代理转发的后端地址，仅本地生效。例如 http://localhost:3000',
  description: '可选项。项目描述信息，将写入项目的 README.md 文件中',
  gitlabHost: 'GitLab 服务器地址，来自系统全局配置，此处仅展示不可编辑',
  gitlabToken: '用于创建项目并推送代码的 Personal Access Token，需包含 api、read_repository、write_repository 权限',
  namespaceId: '支持直接搜索并选择 GitLab 命名空间（Group/User），显示为 full_path 层级。如需精确选择可点击"按层级选择"。',
  visibility: '新建仓库的可见性：private(仅成员可见) / internal(同实例用户可见) / public(公开)',
  createRepo: '开启后会在 GitLab 自动创建项目并推送初始化代码，需要下方 Token、Namespace 等信息正确且具备权限',
  framework: '选择技术栈（当前仅支持 Vue3；后续可直接接入其他框架模板）',
} as const;

export const SCAFFOLD_RULES = {
  activeRule: '规则：以 / 开头，且仅一段路径；允许驼峰(/dmDataSource)或短横线(/data-service)',
} as const;

/** GitLab Namespace 请求失败后的页面反馈。 */
export interface NamespaceErrorFeedback {
  message: string;
  level: 'warning' | 'error';
  shouldClearSelection: boolean;
}

/** 可解析的 GitLab 请求错误结构。 */
interface GitLabRequestError {
  code?: string;
  message?: string;
  status?: number;
  response?: {
    status?: number;
  };
}

/**
 * 将 GitLab Namespace 请求错误映射为稳定、可操作的用户提示。
 * @param error GitLab 请求错误
 * @returns 页面反馈与是否清空已选项
 */
export function getNamespaceErrorFeedback(error: unknown): NamespaceErrorFeedback {
  const candidate = error as GitLabRequestError | null;
  const status = Number(candidate?.response?.status || candidate?.status || 0);
  const code = String(candidate?.code || '');

  if (code === 'INVALID_NAMESPACE_ID') {
    return {
      message: 'Namespace ID 无效，请重新选择 GitLab Group',
      level: 'warning',
      shouldClearSelection: true,
    };
  }

  if (status === 401) {
    return {
      message: 'GitLab 登录已失效，请重新登录后再校验 Namespace',
      level: 'warning',
      shouldClearSelection: false,
    };
  }

  if (status === 403) {
    return {
      message: '当前 Token 无权访问该 Namespace，请重新选择有权限的 GitLab Group',
      level: 'warning',
      shouldClearSelection: true,
    };
  }

  if (status === 404) {
    return {
      message: '该 Namespace 已不存在，请重新选择 GitLab Group',
      level: 'warning',
      shouldClearSelection: true,
    };
  }

  if (status === 429) {
    return {
      message: 'GitLab 请求过于频繁，已保留当前 Namespace，请稍后重试',
      level: 'warning',
      shouldClearSelection: false,
    };
  }

  if (status >= 500) {
    return {
      message: 'GitLab 服务暂时不可用，已保留当前 Namespace，请稍后重试',
      level: 'error',
      shouldClearSelection: false,
    };
  }

  if (!status || ['ECONNABORTED', 'ERR_NETWORK', 'ETIMEDOUT'].includes(code)) {
    return {
      message: '暂时无法连接 GitLab，已保留当前 Namespace，请检查网络或 Host 配置',
      level: 'error',
      shouldClearSelection: false,
    };
  }

  return {
    message: '校验 GitLab Namespace 失败，已保留当前选择，请稍后重试',
    level: 'error',
    shouldClearSelection: false,
  };
}

/**
 * 生成不暴露 Token 明文的短指纹，用于隔离 Namespace 请求缓存。
 * @param value 敏感字符串
 * @returns 稳定短指纹
 */
export function createCredentialFingerprint(value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${value.length}-${(hash >>> 0).toString(16)}`;
}

export const FRAMEWORK_OPTIONS = [
  { label: 'Vue3 微应用', value: 'vue3' },
  { label: '其他框架微应用', value: 'other', disabled: true },
] as const;
