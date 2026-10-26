import { computed, h, reactive, ref, type VNodeChild } from 'vue';
import type { DeployProjectSource } from '@/api/deploy';
import { getBranch, getBranches, getProject, getProjects, type GitLabBranch, type GitLabProject } from '@/api/gitlab';
import {
  BRANCH_CACHE_TTL_MS,
  BRANCH_SEARCH_DEBOUNCE_MS,
  collectMissingBranchNames,
  isBranchListTruncated,
  mergeBranches,
} from './branchOptionsPolicy';
import {
  normalizeSearchKeyword,
  matchProjectCandidate,
  mergeAndDeduplicateProjects,
} from './projectSearchPolicy';

/** 平台创建项目标签 */
const OPS_PROJECT_TOPIC = 'yuyan-ops';

/** 默认项目列表缓存时长：过期后弹窗仍秒开旧列表，并在后台静默刷新 */
const DEFAULT_PROJECTS_TTL_MS = 10 * 60 * 1000;

/** 项目下拉浮层样式类名 */
export const PROJECT_SELECT_DROPDOWN_CLASS = 'project-select-dropdown';

/** 项目下拉展示信息 */
export interface ProjectSelectMeta {
  title: string;
  description?: string;
  path?: string | number;
  id?: string | number;
}

/** 下拉选项 */
export interface SelectOption {
  label: VNodeChild;
  title?: string;
  description?: string;
  searchKey?: string;
  value: string | number;
}

/** 项目来源展示文案 */
const PROJECT_SOURCE_LABEL_MAP: Record<DeployProjectSource, string> = {
  ops: '平台应用',
  gitlab: 'GitLab 仓库',
};

/**
 * 规范化项目来源。
 * @param source 项目来源
 * @returns 有效项目来源
 */
export const normalizeProjectSource = (source?: string): DeployProjectSource => {
  return source === 'gitlab' ? 'gitlab' : 'ops';
};

/**
 * 判断项目是否来自 yuyan-ops 平台创建。
 * @param project GitLab 项目
 * @returns 是否平台应用
 */
const isOpsProject = (project: GitLabProject): boolean => {
  return (
    (Array.isArray(project.topics) && project.topics.includes(OPS_PROJECT_TOPIC)) ||
    (Array.isArray(project.tag_list) && project.tag_list.includes(OPS_PROJECT_TOPIC))
  );
};

/**
 * 生成项目下拉选项内容。
 * @param meta 项目展示信息
 * @returns 项目选项节点
 */
export const renderProjectSelectOptionLabel = (meta: ProjectSelectMeta): VNodeChild => {
  const description = String(meta.description || '').trim();
  return h('div', { class: 'project-select-option' }, [
    h('div', { class: 'project-select-option__title' }, meta.title),
    description ? h('div', { class: 'project-select-option__description' }, description) : null,
  ]);
};

/**
 * 生成通用的双行下拉选项内容。
 * @param meta 选项展示信息
 * @returns 选项节点
 */
export const renderTwoLineSelectOption = (meta: { title: string; description?: string }): VNodeChild => {
  const description = String(meta.description || '').trim();
  return h('div', { class: 'project-select-option' }, [
    h('div', { class: 'project-select-option__title' }, meta.title),
    description ? h('div', { class: 'project-select-option__description' }, description) : null,
  ]);
};

/**
 * 生成项目下拉搜索文本。
 * @param meta 项目展示信息
 * @returns 搜索关键字
 */
export const createProjectSelectSearchKey = (meta: ProjectSelectMeta): string => {
  return [meta.id, meta.title, meta.description, meta.path].filter(Boolean).join(' ');
};

/**
 * 生成分支下拉展示文案。
 * @param branch GitLab 分支
 * @returns 分支下拉文案
 */
const getBranchOptionLabel = (branch: GitLabBranch): string => {
  return branch.default ? `${branch.name}（默认）` : branch.name;
};

/**
 * 管理独立服务器部署目标中的 GitLab 项目和分支选项。
 * @returns 项目与分支选项状态
 */
export function useDeployProjectOptions() {
  const initialLoading = ref(false);
  const searchLoading = ref(false);
  const branchLoading = ref(false);
  const branchProjectId = ref<number | null>(null);
  const projectSource = ref<DeployProjectSource>('ops');
  const searchKeyword = ref('');

  /** 各项目来源默认最近活跃项目 */
  const defaultProjectsBySource = reactive<Record<DeployProjectSource, GitLabProject[]>>({
    ops: [],
    gitlab: [],
  });

  /** 各项目来源默认列表加载时间，用于 10 分钟过期后后台刷新 */
  const defaultProjectsLoadedAt: Record<DeployProjectSource, number> = { ops: 0, gitlab: 0 };

  /** 各项目来源当前搜索结果 */
  const searchProjectsBySource = reactive<Record<DeployProjectSource, GitLabProject[]>>({
    ops: [],
    gitlab: [],
  });

  /** 精准拉取或已选择的项目对象池，用于回显保护 */
  const pinnedProjectsMap = reactive<Map<number, GitLabProject>>(new Map());

  const branches = ref<GitLabBranch[]>([]);
  /** 当前项目分支是否超过单页上限（超过时启用远程搜索与精确补齐） */
  const branchTruncated = ref(false);
  /** 分支列表缓存：项目 ID → 分支、是否截断、过期时间 */
  const branchCache = new Map<number, { items: GitLabBranch[]; truncated: boolean; expiresAt: number }>();
  let branchSearchTimer: ReturnType<typeof setTimeout> | null = null;
  let branchSearchSeq = 0;
  let branchRequestSeq = 0;
  let searchRequestSeq = 0;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  /** 项目加载状态（初始加载或搜索中） */
  const projectLoading = computed(() => initialLoading.value || searchLoading.value);

  /** 当前激活的项目列表 */
  const projects = computed<GitLabProject[]>(() => {
    const source = normalizeProjectSource(projectSource.value);
    const searchContext = normalizeSearchKeyword(searchKeyword.value);

    // 未输入关键字时展示默认最近活跃项目
    if (!searchContext.rawKeyword) {
      return defaultProjectsBySource[source] || [];
    }

    // 1. 本地候选池（默认列表 + 精准缓存池）模糊匹配，保证本地已加载项（如短词 py 命中 pyjob）即时可见且不丢失
    const localPool = [
      ...(defaultProjectsBySource[source] || []),
      ...Array.from(pinnedProjectsMap.values()),
    ];
    const localMatches = localPool.filter((project) => matchProjectCandidate(project, searchContext));

    // 2. 远程搜索结果
    const remoteProjects = searchProjectsBySource[source] || [];

    // 3. 融合去重：本地强匹配项优先保底，远程项增量补充
    return mergeAndDeduplicateProjects(remoteProjects, localMatches);
  });

  /** 项目下拉选项 */
  const projectOptions = computed<SelectOption[]>(() =>
    projects.value.map((project) => {
      const description = String(project.description || '').trim();
      const searchKey = createProjectSelectSearchKey({
        id: project.id,
        title: project.name,
        description,
        path: project.path_with_namespace,
      });
      return {
        label: renderProjectSelectOptionLabel({ title: project.name, description }),
        title: project.name,
        description,
        searchKey,
        value: project.id,
      };
    })
  );

  /** 分支下拉选项 */
  const branchOptions = computed<SelectOption[]>(() =>
    branches.value.map((branch) => {
      const name = branch.name;
      const desc = branch.default ? '默认分支' : '代码分支';
      return {
        label: renderTwoLineSelectOption({ title: name, description: desc }),
        title: name,
        searchKey: `${name} ${desc}`,
        value: name,
      };
    })
  );

  /**
   * 加载部署项目默认列表（最近活跃）。
   * @param source 项目来源
   * @returns 部署项目列表
   */
  const loadProjects = async (source: DeployProjectSource = projectSource.value): Promise<GitLabProject[]> => {
    const normalizedSource = normalizeProjectSource(source);
    projectSource.value = normalizedSource;
    const cachedProjects = defaultProjectsBySource[normalizedSource];
    if (cachedProjects.length) {
      /** 缓存过期时先返回旧列表保证弹窗秒开，再后台静默刷新，避免长时间不刷新页面看不到新项目 */
      if (Date.now() - defaultProjectsLoadedAt[normalizedSource] > DEFAULT_PROJECTS_TTL_MS) {
        void fetchDefaultProjects(normalizedSource).catch((error) => {
          console.warn('[useDeployProjectOptions] 后台刷新项目列表失败:', error);
        });
      }
      return cachedProjects;
    }
    initialLoading.value = true;
    try {
      return await fetchDefaultProjects(normalizedSource);
    } finally {
      initialLoading.value = false;
    }
  };

  /**
   * 拉取并缓存指定来源的默认项目列表。
   * @param normalizedSource 项目来源
   * @returns 部署项目列表
   */
  const fetchDefaultProjects = async (normalizedSource: DeployProjectSource): Promise<GitLabProject[]> => {
    const result = await getProjects({
      page: 1,
      per_page: 100,
      order_by: 'last_activity_at',
      sort: 'desc',
      membership: true,
      ...(normalizedSource === 'ops' ? { topic: OPS_PROJECT_TOPIC } : {}),
    });
    const filtered = normalizedSource === 'ops' ? result.filter(isOpsProject) : result;
    defaultProjectsBySource[normalizedSource] = filtered;
    defaultProjectsLoadedAt[normalizedSource] = Date.now();
    filtered.forEach((p) => pinnedProjectsMap.set(p.id, p));
    return filtered;
  };

  /**
   * 根据项目 ID 查找已缓存或已加载的项目对象。
   * @param source 项目来源
   * @param projectId 项目 ID
   * @returns GitLab 项目
   */
  const findProject = (source: DeployProjectSource, projectId: number): GitLabProject | undefined => {
    const normalizedSource = normalizeProjectSource(source);
    const normalizedId = Number(projectId || 0);
    if (!normalizedId) return undefined;
    return (
      searchProjectsBySource[normalizedSource]?.find((project) => project.id === normalizedId) ||
      defaultProjectsBySource[normalizedSource]?.find((project) => project.id === normalizedId) ||
      pinnedProjectsMap.get(normalizedId)
    );
  };

  /**
   * 精准确保指定项目已加载到缓存池中（用于非前100条历史目标编辑时的回显）。
   * @param projectId 项目 ID
   * @param source 项目来源
   * @returns GitLab 项目详情
   */
  const ensureProjectLoaded = async (projectId: number, source: DeployProjectSource = projectSource.value): Promise<GitLabProject | undefined> => {
    const normalizedId = Number(projectId || 0);
    if (!normalizedId) return undefined;
    const existing = findProject(source, normalizedId);
    if (existing) return existing;
    try {
      const project = await getProject(normalizedId);
      if (project) {
        pinnedProjectsMap.set(project.id, project);
        return project;
      }
    } catch (error) {
      console.warn(`[useDeployProjectOptions] 获取项目详情失败 ID: ${normalizedId}`, error);
    }
    return undefined;
  };

  /**
   * 防抖远程搜索 GitLab 项目。
   * @param keyword 搜索关键字
   * @param source 项目来源
   */
  const searchProjects = (keyword: string, source: DeployProjectSource = projectSource.value) => {
    const searchContext = normalizeSearchKeyword(keyword);
    searchKeyword.value = searchContext.rawKeyword;
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    if (!searchContext.rawKeyword) {
      searchLoading.value = false;
      return;
    }
    searchLoading.value = true;
    const remoteQuery = searchContext.compactKeyword || searchContext.rawKeyword;
    searchTimer = setTimeout(async () => {
      const currentSeq = ++searchRequestSeq;
      const normalizedSource = normalizeProjectSource(source);
      try {
        const result = await getProjects({
          search: remoteQuery,
          per_page: 50,
          order_by: 'last_activity_at',
          sort: 'desc',
          membership: true,
          ...(normalizedSource === 'ops' ? { topic: OPS_PROJECT_TOPIC } : {}),
        });
        if (currentSeq === searchRequestSeq && searchKeyword.value === searchContext.rawKeyword) {
          const filtered = normalizedSource === 'ops' ? result.filter(isOpsProject) : result;
          searchProjectsBySource[normalizedSource] = filtered;
          filtered.forEach((p) => pinnedProjectsMap.set(p.id, p));
        }
      } catch (error) {
        console.error('[useDeployProjectOptions] 搜索 GitLab 项目失败:', error);
      } finally {
        if (currentSeq === searchRequestSeq) {
          searchLoading.value = false;
        }
      }
    }, 300);
  };

  /** 重置搜索关键字与搜索结果 */
  const resetSearch = () => {
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    searchKeyword.value = '';
    searchLoading.value = false;
  };

  /** 取消待触发的分支远程搜索 */
  const cancelBranchSearch = () => {
    branchSearchSeq += 1;
    if (!branchSearchTimer) return;
    clearTimeout(branchSearchTimer);
    branchSearchTimer = null;
  };

  /**
   * 加载指定项目分支。
   * @description
   * - 按项目缓存 60 秒，编辑目标、切换项目时优先展示缓存，避免重复请求 GitLab；
   * - 分支超过单页上限时，精确补齐项目默认分支、当前已选分支和 dev，修复长列表截断导致选不到分支的问题。
   * @param projectId 项目 ID
   * @param options.ensure 必须可选的分支名称（如编辑回显的已选分支）
   * @returns 分支列表
   */
  const loadBranches = async (projectId: number, options: { ensure?: Array<string | null | undefined> } = {}): Promise<GitLabBranch[]> => {
    const normalizedProjectId = Number(projectId || 0);
    const currentSeq = ++branchRequestSeq;
    cancelBranchSearch();
    if (!normalizedProjectId) {
      branchProjectId.value = null;
      branches.value = [];
      branchTruncated.value = false;
      return [];
    }
    branchProjectId.value = normalizedProjectId;
    const cached = branchCache.get(normalizedProjectId);
    const cacheFresh = Boolean(cached && cached.expiresAt > Date.now());
    branches.value = cached?.items || [];
    branchTruncated.value = cached?.truncated || false;
    branchLoading.value = !cached;
    try {
      const firstPage = cacheFresh && cached ? cached.items : await getBranches(normalizedProjectId);
      const truncated = cacheFresh && cached ? cached.truncated : isBranchListTruncated(firstPage);
      let result = mergeBranches(firstPage);
      if (truncated) {
        const project = findProject(projectSource.value, normalizedProjectId) || pinnedProjectsMap.get(normalizedProjectId);
        const missingNames = collectMissingBranchNames(result, [project?.default_branch, ...(options.ensure || []), 'dev']);
        if (missingNames.length) {
          const extras = await Promise.all(missingNames.map((name) => getBranch(normalizedProjectId, name).catch(() => null)));
          result = mergeBranches(extras.filter((branch): branch is GitLabBranch => Boolean(branch)), result);
        }
      }
      branchCache.set(normalizedProjectId, {
        items: result,
        truncated,
        expiresAt: cacheFresh && cached ? cached.expiresAt : Date.now() + BRANCH_CACHE_TTL_MS,
      });
      if (currentSeq === branchRequestSeq && branchProjectId.value === normalizedProjectId) {
        branches.value = result;
        branchTruncated.value = truncated;
      }
      return result;
    } finally {
      if (currentSeq === branchRequestSeq) {
        branchLoading.value = false;
      }
    }
  };

  /**
   * 防抖远程搜索当前项目分支。
   * @description 仅在分支超过单页上限时请求 GitLab；完整列表直接走下拉本地过滤，不产生请求。
   * @param keyword 搜索关键字
   */
  const searchBranches = (keyword: string) => {
    cancelBranchSearch();
    const projectId = Number(branchProjectId.value || 0);
    const searchText = String(keyword || '').trim();
    if (!projectId || !searchText || !branchTruncated.value) return;
    const currentSeq = branchSearchSeq;
    branchSearchTimer = setTimeout(async () => {
      branchSearchTimer = null;
      try {
        const result = await getBranches(projectId, { search: searchText });
        if (currentSeq !== branchSearchSeq || branchProjectId.value !== projectId) return;
        const merged = mergeBranches(branches.value, result);
        branches.value = merged;
        const cached = branchCache.get(projectId);
        if (cached) branchCache.set(projectId, { ...cached, items: merged });
      } catch (error) {
        console.warn('[useDeployProjectOptions] 远程搜索分支失败:', error);
      }
    }, BRANCH_SEARCH_DEBOUNCE_MS);
  };

  /**
   * 从项目分支中解析可用默认分支。
   * @param fallbackBranch 兜底分支
   * @returns 默认分支名称
   */
  const resolveDefaultBranch = (fallbackBranch = 'dev'): string => {
    const fallback = String(fallbackBranch || '').trim();
    return (
      branches.value.find((branch) => branch.default)?.name ||
      branches.value.find((branch) => branch.name === fallback)?.name ||
      branches.value[0]?.name ||
      fallback ||
      'dev'
    );
  };

  return {
    projectLoading,
    searchLoading,
    branchLoading,
    branchProjectId,
    projectSource,
    searchKeyword,
    projects,
    branches,
    projectOptions,
    branchOptions,
    loadProjects,
    searchProjects,
    resetSearch,
    findProject,
    ensureProjectLoaded,
    loadBranches,
    searchBranches,
    branchTruncated,
    resolveDefaultBranch,
    normalizeProjectSource,
    getProjectSourceLabel: (source?: string) => PROJECT_SOURCE_LABEL_MAP[normalizeProjectSource(source)],
  };
}
