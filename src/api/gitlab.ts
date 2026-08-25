import axios, { type AxiosResponse } from 'axios';

// GitLab 用户接口定义
export interface GitLabUser {
  id: number;
  username: string;
  name: string;
  avatar_url: string;
  email?: string;
  web_url: string;
  state: string;
  created_at: string;
  bio?: string;
  location?: string;
  public_email?: string;
  skype?: string;
  linkedin?: string;
  twitter?: string;
  website_url?: string;
  organization?: string;
  job_title?: string;
  pronouns?: string;
  bot?: boolean;
  work_information?: string;
  followers?: number;
  following?: number;
  local_time?: string;
  last_sign_in_at?: string;
  confirmed_at?: string;
  theme_id?: number;
  last_activity_on?: string;
  color_scheme_id?: number;
  projects_limit?: number;
  current_sign_in_at?: string;
  identities?: any[];
  can_create_group?: boolean;
  can_create_project?: boolean;
  two_factor_enabled?: boolean;
  external?: boolean;
  private_profile?: boolean;
  commit_email?: string;
  shared_runners_minutes_limit?: number;
  extra_shared_runners_minutes_limit?: number;
}

// GitLab 项目接口定义
export interface GitLabProject {
  id: number;
  name: string;
  name_with_namespace: string;
  path: string;
  path_with_namespace: string;
  description: string;
  visibility: 'private' | 'internal' | 'public';
  web_url: string;
  ssh_url_to_repo: string;
  http_url_to_repo: string;
  readme_url: string | null;
  default_branch: string;
  tag_list: string[];
  topics: string[];
  owner: {
    id: number;
    name: string;
    username: string;
    avatar_url: string;
    web_url: string;
  };
  creator_id: number;
  namespace: {
    id: number;
    name: string;
    path: string;
    kind: string;
    full_path: string;
    parent_id: number | null;
    avatar_url: string | null;
    web_url: string;
  };
  created_at: string;
  last_activity_at: string;
  forks_count: number;
  star_count: number;
  open_issues_count: number;
  public_jobs: boolean;
  shared_with_groups: any[];
  only_allow_merge_if_pipeline_succeeds: boolean;
  allow_merge_on_skipped_pipeline: boolean;
  only_allow_merge_if_all_discussions_are_resolved: boolean;
  remove_source_branch_after_merge: boolean;
  request_access_enabled: boolean;
  merge_method: string;
  squash_option: string;
  auto_devops_enabled: boolean;
  auto_devops_deploy_strategy: string;
  repository_storage: string;
  has_vulnerability: boolean;
  compliance_frameworks: any[];
  issues_template: string | null;
  merge_requests_template: string | null;
  merge_pipelines_enabled: boolean;
  merge_trains_enabled: boolean;
  mirror: boolean;
  mirror_user_id: number | null;
  mirror_trigger_builds: boolean;
  only_mirror_protected_branches: boolean;
  mirror_overwrites_diverged_branches: boolean;
  external_authorization_classification_label: string;
  licensed: boolean;
  suggestions: any[];
  statistics: {
    commit_count: number;
    storage_size: number;
    repository_size: number;
    wiki_size: number;
    lfs_objects_size: number;
    job_artifacts_size: number;
    packages_size: number;
  };
}

// GitLab 分组接口定义
export interface GitLabGroup {
  id: number;
  name: string;
  path: string;
  description: string;
  visibility: 'private' | 'internal' | 'public';
  lfs_enabled: boolean;
  avatar_url: string | null;
  web_url: string;
  request_access_enabled: boolean;
  full_name: string;
  full_path: string;
  parent_id: number | null;
  projects: GitLabProject[];
}

// GitLab 命名空间接口定义（包含 group 与 user 两类）
export interface GitLabNamespace {
  id: number;
  name: string;
  path: string;
  kind: 'group' | 'user';
  full_path: string;
  parent_id: number | null;
  avatar_url?: string | null;
  web_url?: string;
  members_count_with_descendants?: number;
}

/** GitLab 分页请求基础参数。 */
export interface GitLabPaginationParams {
  page?: number;
  per_page?: number;
}

/** GitLab 分组搜索参数。 */
export interface GitLabGroupSearchParams extends GitLabPaginationParams {
  search?: string;
  top_level_only?: boolean;
  all_available?: boolean;
  owned?: boolean;
  min_access_level?: number;
  active?: boolean;
  with_projects?: boolean;
  order_by?: 'name' | 'path' | 'id' | 'similarity';
  sort?: 'asc' | 'desc';
}

/** GitLab Namespace 搜索参数。 */
export interface GitLabNamespaceSearchParams extends GitLabPaginationParams {
  search?: string;
  owned_only?: boolean;
  top_level_only?: boolean;
  full_path_search?: boolean;
}

/** GitLab 分页列表结果。 */
export interface GitLabPagedList<T> {
  items: T[];
  hasMore: boolean;
  pageCount: number;
}

// 搜索参数接口
export interface ProjectSearchParams {
  search?: string; // 项目名称或描述搜索
  id?: number; // 项目ID精确匹配
  owned?: boolean; // 只显示拥有的项目
  starred?: boolean; // 只显示星标项目
  membership?: boolean; // 只显示成员项目
  visibility?: 'private' | 'internal' | 'public'; // 可见性筛选
  archived?: boolean; // 是否归档
  min_access_level?: number; // 最小访问级别
  simple?: boolean; // 简化的项目信息
  include_subgroups?: boolean; // 包含子分组
  page?: number; // 页码
  per_page?: number; // 每页数量
  order_by?: 'id' | 'name' | 'path' | 'created_at' | 'updated_at' | 'last_activity_at'; // 排序字段
  sort?: 'asc' | 'desc'; // 排序方向
  // GitLab API 支持的其他参数
  [key: string]: any;
}

// API响应接口
export interface GitLabAPIResponse<T> {
  data: T;
  status: number;
  statusText: string;
  headers: any;
}

// 分组树形结构接口
export interface GroupTreeNode {
  id: number;
  name: string;
  path: string;
  full_path: string;
  description: string;
  visibility: string;
  web_url: string;
  avatar_url: string | null;
  parent_id: number | null;
  children?: GroupTreeNode[];
  projects?: GitLabProject[];
  level: number;
  isGroup: boolean;
  isExpanded?: boolean;
  hasChildren?: boolean;
}

/**
 * 从 GitLab 响应头中读取下一页页码。
 * @param response GitLab API 响应
 * @returns 下一页页码，没有更多数据时返回空字符串
 */
const getNextPage = <T>(response: AxiosResponse<T>): string => {
  const nextPage = response.headers?.['x-next-page'];
  return Array.isArray(nextPage) ? nextPage[0] || '' : String(nextPage || '');
};

/**
 * 分页读取 GitLab 列表接口。
 * @param url 接口路径
 * @param params 查询参数
 * @param maxPages 最大读取页数
 * @returns 合并后的分页列表
 */
const fetchGitLabPagedList = async <T>(url: string, params: Record<string, unknown>, maxPages = 1): Promise<GitLabPagedList<T>> => {
  const items: T[] = [];
  let page = Number(params.page || 1);
  let pageCount = 0;
  let hasMore = false;

  while (pageCount < maxPages) {
    const response = await gitlabClient.get<T[]>(url, {
      params: {
        ...params,
        page,
      },
    });

    items.push(...response.data);
    pageCount += 1;

    const nextPage = getNextPage(response);
    if (!nextPage) {
      hasMore = false;
      break;
    }

    hasMore = true;
    page = Number(nextPage);
    if (!page || Number.isNaN(page)) break;
  }

  return { items, hasMore, pageCount };
};

// GitLab配置管理
class GitLabConfig {
  private static instance: GitLabConfig;
  private gitlabHost: string = import.meta.env.VITE_GITLAB_HOST || '';

  static getInstance(): GitLabConfig {
    if (!GitLabConfig.instance) {
      GitLabConfig.instance = new GitLabConfig();
    }
    return GitLabConfig.instance;
  }

  getGitLabHost(): string {
    return this.gitlabHost;
  }

  setGitLabHost(host: string): void {
    this.gitlabHost = host || import.meta.env.VITE_GITLAB_HOST || '';
  }
}

import { isTauri } from '@/utils/env';

// 获取GitLab API的基础URL
const getGitLabBaseURL = () => {
  if (isTauri()) {
    const host = GitLabConfig.getInstance().getGitLabHost();
    return host.endsWith('/api/v4') ? host : `${host.replace(/\/$/, '')}/api/v4`;
  }
  // 在生产环境中直接使用GitLab服务器地址，在开发环境中使用代理
  if (import.meta.env.PROD) {
    return import.meta.env.VITE_GITLAB_HOST ? `${import.meta.env.VITE_GITLAB_HOST.replace(/\/$/, '')}/api/v4` : '/api/v4';
  }
  return '/api/v4';
};

// 创建GitLab API客户端
let activeGitlabToken = '';
let gitlabClient = axios.create({
  baseURL: getGitLabBaseURL(),
  timeout: 15000, // 增加超时时间
  headers: {
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  },
});

// 更新GitLab客户端配置
export const updateGitLabClient = (host?: string) => {
  const gitlabConfig = GitLabConfig.getInstance();
  if (host) {
    gitlabConfig.setGitLabHost(host);
  }

  // 重新创建客户端实例以应用新的配置
  gitlabClient = axios.create({
    baseURL: getGitLabBaseURL(),
    timeout: 15000,
    headers: {
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });

  // 重新应用拦截器
  gitlabClient.interceptors.request.use(
    (config) => {
      const token = activeGitlabToken;
      if (token) {
        config.headers['PRIVATE-TOKEN'] = token;
        config.headers['Authorization'] = `Bearer ${token}`;
      }

      config.headers['X-GitLab-Host'] = gitlabConfig.getGitLabHost();
      return config;
    },
    (error) => Promise.reject(error)
  );

  gitlabClient.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error.response?.status === 401) {
        activeGitlabToken = '';
        delete gitlabClient.defaults.headers.common['PRIVATE-TOKEN'];
      }
      return Promise.reject(error);
    }
  );
};

// 请求拦截器：添加认证头和动态host
gitlabClient.interceptors.request.use(
  (config) => {
    const token = activeGitlabToken;
    if (token) {
      config.headers['PRIVATE-TOKEN'] = token;
      // 同时设置Authorization头（某些GitLab版本可能需要）
      config.headers['Authorization'] = `Bearer ${token}`;
    }

    // 添加GitLab服务器地址到请求头（用于调试）
    const gitlabConfig = GitLabConfig.getInstance();
    config.headers['X-GitLab-Host'] = gitlabConfig.getGitLabHost();

    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// 响应拦截器：统一错误处理
gitlabClient.interceptors.response.use(
  (response) => {
    // 检查 304 状态码（理论上配置了 no-cache 后不应出现）
    if (response.status === 304) {
      console.warn('收到 304 响应，但 axios 配置了 no-cache，不应出现此情况', response.config.url);
    }
    return response;
  },
  (error) => {
    if (error.response?.status === 401) {
      // Token过期或无效
      activeGitlabToken = '';
      // 可以在这里触发重新登录逻辑
    }
    return Promise.reject(error);
  }
);

/**
 * 获取项目列表
 * @param params 搜索参数
 * @returns 项目列表
 */
export const getProjects = async (params: ProjectSearchParams = {}): Promise<GitLabProject[]> => {
  try {
    const response = await gitlabClient.get<GitLabProject[]>('/projects', { params });
    return response.data;
  } catch (error) {
    console.error('获取项目列表失败:', error);
    throw error;
  }
};

/**
 * 获取单个项目详情
 * @param projectId 项目ID
 * @returns 项目详情
 */
export const getProject = async (projectId: number): Promise<GitLabProject> => {
  try {
    const response = await gitlabClient.get<GitLabProject>(`/projects/${projectId}`);
    return response.data;
  } catch (error) {
    console.error('获取项目详情失败:', error);
    throw error;
  }
};

/**
 * 根据ID获取项目（返回数组格式，与getProjects保持一致）
 * @param projectId 项目ID
 * @returns 项目数组
 */
export const getProjectById = async (projectId: number): Promise<GitLabProject[]> => {
  try {
    const project = await getProject(projectId);
    return [project];
  } catch (error) {
    console.error('根据ID获取项目失败:', error);
    throw error;
  }
};

/**
 * 获取分组列表
 * @param params 搜索参数
 * @returns 分组列表
 */
export const getGroups = async (params: GitLabGroupSearchParams = {}): Promise<GitLabGroup[]> => {
  try {
    const response = await gitlabClient.get<GitLabGroup[]>('/groups', { params });
    return response.data;
  } catch (error) {
    console.error('获取分组列表失败:', error);
    throw error;
  }
};

/**
 * 获取指定分组详情
 */
export const getGroupById = async (groupId: number): Promise<GitLabGroup> => {
  try {
    const response = await gitlabClient.get<GitLabGroup>(`/groups/${groupId}`);
    return response.data as unknown as GitLabGroup;
  } catch (error) {
    console.error('获取分组详情失败:', error);
    throw error;
  }
};

/**
 * 通过 full_path 获取分组详情（GitLab 支持用路径作为 id）
 */
export const getGroupByPath = async (fullPath: string): Promise<GitLabGroup> => {
  try {
    // 需要对路径进行 URL 编码，形如 group%2Fsubgroup
    const encoded = encodeURIComponent(fullPath);
    const response = await gitlabClient.get<GitLabGroup>(`/groups/${encoded}`);
    return response.data as unknown as GitLabGroup;
  } catch (error) {
    console.error('根据 full_path 获取分组详情失败:', error);
    throw error;
  }
};

/**
 * 获取顶层分组（不包含子分组）
 */
export const getTopLevelGroups = async (params: any = {}): Promise<GitLabGroup[]> => {
  try {
    const result = await fetchGitLabPagedList<GitLabGroup>(
      '/groups',
      { all_available: true, top_level_only: true, with_projects: false, per_page: 100, ...params },
      5
    );
    return result.items;
  } catch (error) {
    console.error('获取顶层分组失败:', error);
    throw error;
  }
};

/**
 * 获取某个分组的直接子分组
 */
export const getGroupSubgroups = async (groupId: number, params: any = {}): Promise<GitLabGroup[]> => {
  try {
    const result = await fetchGitLabPagedList<GitLabGroup>(
      `/groups/${groupId}/subgroups`,
      { all_available: true, with_projects: false, per_page: 100, ...params },
      5
    );
    return result.items;
  } catch (error) {
    console.error('获取子分组失败:', error);
    throw error;
  }
};

/**
 * 分页搜索命名空间。
 * @param keyword 搜索关键词
 * @param params 查询参数
 * @param maxPages 最大读取页数
 * @returns 分页命名空间结果
 */
export const searchNamespacesPaged = async (
  keyword: string,
  params: GitLabNamespaceSearchParams = {},
  maxPages = 5
): Promise<GitLabPagedList<GitLabNamespace>> => {
  try {
    return await fetchGitLabPagedList<GitLabNamespace>(
      '/namespaces',
      {
        search: keyword,
        full_path_search: true,
        per_page: 100,
        ...params,
      },
      maxPages
    );
  } catch (error) {
    console.error('搜索命名空间失败:', error);
    throw error;
  }
};

/**
 * 关键字搜索命名空间（Group 与 User 均会返回）。
 * @param keyword 搜索关键词
 * @param params 查询参数
 * @returns 命名空间列表
 */
export const searchNamespaces = async (keyword: string, params: GitLabNamespaceSearchParams = {}): Promise<GitLabNamespace[]> => {
  const result = await searchNamespacesPaged(keyword, params);
  return result.items;
};

/**
 * 分页搜索 GitLab 分组。
 * @param keyword 搜索关键词
 * @param params 查询参数
 * @param maxPages 最大读取页数
 * @returns 分页分组结果
 */
export const searchGroupsPaged = async (
  keyword: string,
  params: GitLabGroupSearchParams = {},
  maxPages = 5
): Promise<GitLabPagedList<GitLabGroup>> => {
  try {
    return await fetchGitLabPagedList<GitLabGroup>(
      '/groups',
      {
        search: keyword,
        all_available: true,
        with_projects: false,
        per_page: 100,
        ...params,
      },
      maxPages
    );
  } catch (error) {
    console.error('搜索分组失败:', error);
    throw error;
  }
};

/**
 * 根据 ID 获取命名空间详情
 */
export const getNamespaceById = async (id: number): Promise<GitLabNamespace> => {
  try {
    const response = await gitlabClient.get<GitLabNamespace>(`/namespaces/${id}`);
    return response.data;
  } catch (error) {
    console.error('获取命名空间详情失败:', error);
    throw error;
  }
};

/**
 * 获取分组树形结构
 * @returns 分组树形结构
 */
export const getGroupTree = async (): Promise<GroupTreeNode[]> => {
  try {
    const response = await gitlabClient.get<GroupTreeNode[]>('/groups', {
      params: { all_available: true, top_level_only: true },
    });

    // 构建树形结构
    const buildTree = (groups: GroupTreeNode[], parentId: number | null = null, level = 0): GroupTreeNode[] => {
      return groups
        .filter((group) => group.parent_id === parentId)
        .map((group) => ({
          ...group,
          level,
          isGroup: true,
          children: buildTree(groups, group.id, level + 1),
          isExpanded: level < 2, // 前两级默认展开
          hasChildren: groups.some((g) => g.parent_id === group.id),
        }));
    };

    const treeData = buildTree(response.data);

    // 为每个分组添加项目
    for (const group of treeData) {
      await addProjectsToGroup(group);
    }

    return treeData;
  } catch (error) {
    console.error('获取分组树失败:', error);
    throw error;
  }
};

/**
 * 为分组添加项目
 * @param group 分组节点
 */
const addProjectsToGroup = async (group: GroupTreeNode): Promise<void> => {
  try {
    const projects = await getProjects({
      search: undefined,
      // 可以根据需要添加更多筛选条件
    });

    // 筛选属于当前分组的项目
    group.projects = projects.filter((project) => {
      // 这里需要根据项目的命名空间路径来判断是否属于当前分组
      return project.namespace.full_path.startsWith(group.full_path);
    });
  } catch (error) {
    console.error(`为分组 ${group.name} 添加项目失败:`, error);
  }
};

/**
 * 搜索项目（带关键词高亮）
 * @param keyword 搜索关键词
 * @returns 匹配的项目列表
 */
export const searchProjects = async (keyword: string): Promise<GitLabProject[]> => {
  try {
    const response = await gitlabClient.get<GitLabProject[]>('/projects', {
      params: { search: keyword },
    });
    return response.data;
  } catch (error) {
    console.error('搜索项目失败:', error);
    throw error;
  }
};

/**
 * 获取项目统计信息
 * @param projectId 项目ID
 * @returns 项目统计信息
 */
export const getProjectStatistics = async (projectId: number) => {
  try {
    const response = await gitlabClient.get(`/projects/${projectId}/statistics`);
    return response.data;
  } catch (error) {
    console.error('获取项目统计信息失败:', error);
    throw error;
  }
};

/**
 * 设置GitLab认证Token
 * @param token GitLab访问令牌
 */
export const setGitLabToken = (token: string): void => {
  activeGitlabToken = token;
  if (token) {
    gitlabClient.defaults.headers.common['PRIVATE-TOKEN'] = token;
  } else {
    delete gitlabClient.defaults.headers.common['PRIVATE-TOKEN'];
  }
};

/**
 * 获取当前GitLab认证状态
 * @returns 是否已认证
 */
export const getGitLabAuthStatus = (): boolean => {
  return Boolean(activeGitlabToken);
};

/** 获取仅存在当前进程内存中的 GitLab PAT。 */
export const getGitLabToken = (): string => activeGitlabToken;

/**
 * 获取GitLab配置实例
 * @returns GitLab配置实例
 */
export const getGitLabConfig = (): GitLabConfig => {
  return GitLabConfig.getInstance();
};

/**
 * 设置GitLab服务器地址
 * @param host GitLab服务器地址
 */
export const setGitLabHost = (host: string): void => {
  GitLabConfig.getInstance().setGitLabHost(host);
};

/**
 * 获取GitLab服务器地址
 * @returns GitLab服务器地址
 */
export const getGitLabHost = (): string => {
  return GitLabConfig.getInstance().getGitLabHost();
};

/**
 * 获取当前用户信息
 * @returns 当前用户信息
 */
export const getCurrentUser = async (): Promise<GitLabUser> => {
  try {
    const response = await gitlabClient.get<GitLabUser>('/user');
    return response.data;
  } catch (error) {
    console.error('获取当前用户信息失败:', error);
    throw error;
  }
};

export default gitlabClient;

// ====== GitOps 相关：按路径查项目 / 分支 / 树 / 文件 / 提交 ======

/**
 * 根据 full_path 获取项目（GitLab 支持用路径作为 id）
 */
export const getProjectByPath = async (fullPath: string): Promise<GitLabProject> => {
  try {
    const encoded = encodeURIComponent(fullPath);
    const { data } = await gitlabClient.get<GitLabProject>(`/projects/${encoded}`);
    return data;
  } catch (error) {
    console.error('根据 full_path 获取项目失败:', error);
    throw error;
  }
};

export interface GitLabBranch {
  name: string;
  default?: boolean;
}

/** 获取项目分支列表 */
export const getBranches = async (projectId: number): Promise<GitLabBranch[]> => {
  try {
    const { data } = await gitlabClient.get<GitLabBranch[]>(`/projects/${projectId}/repository/branches`, {
      params: { per_page: 100 },
    });
    return data;
  } catch (error) {
    console.error('获取分支列表失败:', error);
    throw error;
  }
};

/**
 * 创建分支（从指定 ref 创建）
 */
export const createBranch = async (projectId: number, branch: string, ref: string): Promise<GitLabBranch> => {
  try {
    const { data } = await gitlabClient.post<GitLabBranch>(`/projects/${projectId}/repository/branches`, null, { params: { branch, ref } });
    return data;
  } catch (error) {
    // 由调用方决定如何处理“已存在”等场景
    console.error('创建分支失败:', error);
    throw error;
  }
};

export interface RepoTreeItem {
  id: string;
  name: string;
  type: 'tree' | 'blob';
  path: string;
  mode?: string;
}

/** 获取仓库树（支持递归，支持分页） */
export const getRepoTree = async (
  projectId: number,
  pathParam: string,
  ref: string,
  recursive = true,
  page = 1,
  perPage = 100
): Promise<RepoTreeItem[]> => {
  try {
    const response = await gitlabClient.get<RepoTreeItem[]>(`/projects/${projectId}/repository/tree`, {
      params: { path: pathParam, ref, recursive, page, per_page: perPage },
    });

    // 防御性检查：确保返回数组
    if (!response.data || !Array.isArray(response.data)) {
      console.error('getRepoTree 返回数据异常:', {
        status: response.status,
        data: response.data,
        url: response.config.url,
      });
      return [];
    }

    return response.data;
  } catch (error) {
    console.error('获取仓库树失败:', error);
    throw error;
  }
};

/**
 * 读取文件内容（自动 base64 解码）
 */
// 以 UTF-8 正确解码 base64，避免中文乱码
const decodeBase64Utf8 = (base64: string): string => {
  try {
    const binary = typeof atob === 'function' ? atob(base64) : '';
    // 将 binary string 转为字节数组，再用 TextDecoder 解码为 UTF-8
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder('utf-8').decode(bytes);
    }
    // 退化方案：老浏览器使用 escape/encode 组合
    return decodeURIComponent(escape(binary));
  } catch {
    // 最后兜底
    return typeof atob === 'function' ? atob(base64) : base64;
  }
};

export const getFileContent = async (projectId: number, filePath: string, ref: string): Promise<{ file_path: string; content: string }> => {
  try {
    const encoded = encodeURIComponent(filePath);
    const { data } = await gitlabClient.get(`/projects/${projectId}/repository/files/${encoded}`, { params: { ref } });
    const raw = (data as any).content;
    const encoding = (data as any).encoding;
    const decoded = encoding === 'base64' ? decodeBase64Utf8(raw) : raw;
    return { file_path: (data as any).file_path as string, content: decoded as string };
  } catch (error) {
    console.error(`读取文件失败: ${filePath}`, error);
    throw error;
  }
};

/**
 * 尝试读取仓库文件；文件不存在时安静返回 null。
 * @param projectId GitLab 项目 ID
 * @param filePath 仓库文件路径
 * @param ref 分支或 Commit
 * @returns 文件内容，不存在时返回 null
 */
export const getFileContentIfExists = async (projectId: number, filePath: string, ref: string): Promise<{ file_path: string; content: string } | null> => {
  try {
    const encoded = encodeURIComponent(filePath);
    const { data } = await gitlabClient.get(`/projects/${projectId}/repository/files/${encoded}`, { params: { ref } });
    const raw = (data as any).content;
    const encoding = (data as any).encoding;
    const decoded = encoding === 'base64' ? decodeBase64Utf8(raw) : raw;
    return { file_path: (data as any).file_path as string, content: decoded as string };
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) return null;
    throw error;
  }
};

export type CommitAction = {
  action: 'create' | 'update' | 'delete' | 'move' | 'chmod';
  file_path: string;
  content?: string;
  previous_path?: string;
  execute_filemode?: boolean;
};

/** 批量提交变更 */
export const createCommit = async (projectId: number, branch: string, commitMessage: string, actions: CommitAction[]) => {
  try {
    const payload = { branch, commit_message: commitMessage, actions };
    const { data } = await gitlabClient.post(`/projects/${projectId}/repository/commits`, payload);
    return data;
  } catch (error) {
    console.error('创建提交失败:', error);
    throw error;
  }
};

// ====== Merge Request 相关 ======

export interface MergeRequestMinimal {
  id: number;
  iid: number;
  title: string;
  web_url: string;
  state: string;
}

export type CreateMergeRequestParams = {
  source_branch: string;
  target_branch: string;
  title: string;
  description?: string;
  remove_source_branch?: boolean;
  squash?: boolean;
  allow_collaboration?: boolean;
  draft?: boolean;
  labels?: string; // 逗号分隔
};

/** 创建 Merge Request */
export const createMergeRequest = async (projectId: number, params: CreateMergeRequestParams): Promise<MergeRequestMinimal> => {
  try {
    const { data } = await gitlabClient.post<MergeRequestMinimal>(`/projects/${projectId}/merge_requests`, params);
    return data;
  } catch (error) {
    console.error('创建 Merge Request 失败:', error);
    throw error;
  }
};
