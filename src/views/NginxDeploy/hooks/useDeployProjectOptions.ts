import { computed, h, reactive, ref, type VNodeChild } from 'vue';
import type { DeployProjectSource } from '@/api/deploy';
import { getBranches, getProjects, type GitLabBranch, type GitLabProject } from '@/api/gitlab';

/** 平台创建项目标签 */
const OPS_PROJECT_TOPIC = 'yuyan-ops';

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
  const projectLoading = ref(false);
  const branchLoading = ref(false);
  const branchProjectId = ref<number | null>(null);
  const projectSource = ref<DeployProjectSource>('ops');
  const projectsBySource = reactive<Record<DeployProjectSource, GitLabProject[]>>({
    ops: [],
    gitlab: [],
  });
  const branches = ref<GitLabBranch[]>([]);
  let branchRequestSeq = 0;

  const projects = computed(() => projectsBySource[projectSource.value]);

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

  const branchOptions = computed<SelectOption[]>(() =>
    branches.value.map((branch) => {
      const label = getBranchOptionLabel(branch);
      return {
        label,
        title: label,
        searchKey: label,
        value: branch.name,
      };
    })
  );

  /**
   * 加载部署项目列表。
   * @param source 项目来源
   * @returns 部署项目列表
   */
  const loadProjects = async (source: DeployProjectSource = projectSource.value): Promise<GitLabProject[]> => {
    const normalizedSource = normalizeProjectSource(source);
    projectSource.value = normalizedSource;
    if (projectsBySource[normalizedSource].length) return projectsBySource[normalizedSource];
    projectLoading.value = true;
    try {
      const result = await getProjects({
        page: 1,
        per_page: 100,
        order_by: 'last_activity_at',
        sort: 'desc',
        membership: true,
        ...(normalizedSource === 'ops' ? { topic: OPS_PROJECT_TOPIC } : {}),
      });
      projectsBySource[normalizedSource] = normalizedSource === 'ops' ? result.filter(isOpsProject) : result;
      return projectsBySource[normalizedSource];
    } finally {
      projectLoading.value = false;
    }
  };

  /**
   * 根据项目 ID 查找已加载项目。
   * @param source 项目来源
   * @param projectId 项目 ID
   * @returns GitLab 项目
   */
  const findProject = (source: DeployProjectSource, projectId: number): GitLabProject | undefined => {
    const normalizedSource = normalizeProjectSource(source);
    return projectsBySource[normalizedSource].find((project) => project.id === Number(projectId));
  };

  /**
   * 加载指定项目分支。
   * @param projectId 项目 ID
   * @returns 分支列表
   */
  const loadBranches = async (projectId: number): Promise<GitLabBranch[]> => {
    const normalizedProjectId = Number(projectId || 0);
    const currentSeq = ++branchRequestSeq;
    if (!normalizedProjectId) {
      branchProjectId.value = null;
      branches.value = [];
      return [];
    }
    branchProjectId.value = normalizedProjectId;
    branches.value = [];
    branchLoading.value = true;
    try {
      const result = await getBranches(normalizedProjectId);
      if (currentSeq === branchRequestSeq && branchProjectId.value === normalizedProjectId) {
        branches.value = result;
      }
      return result;
    } finally {
      if (currentSeq === branchRequestSeq) {
        branchLoading.value = false;
      }
    }
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
    branchLoading,
    branchProjectId,
    projectSource,
    projects,
    branches,
    projectOptions,
    branchOptions,
    loadProjects,
    findProject,
    loadBranches,
    resolveDefaultBranch,
    normalizeProjectSource,
    getProjectSourceLabel: (source?: string) => PROJECT_SOURCE_LABEL_MAP[normalizeProjectSource(source)],
  };
}
