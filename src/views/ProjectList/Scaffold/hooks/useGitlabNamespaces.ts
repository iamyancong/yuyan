import { computed, ref } from 'vue';
import { message } from 'ant-design-vue';
import {
  getGroupById,
  getGroupSubgroups,
  getTopLevelGroups,
  searchGroupsPaged,
  searchNamespacesPaged,
  type GitLabGroup,
  type GitLabNamespace,
} from '@/api/gitlab';

/** Namespace 搜索最大分页数。 */
const SEARCH_MAX_PAGES = 5;

/** Namespace 搜索防抖间隔。 */
const SEARCH_DEBOUNCE_MS = 300;

/** TreeSelect 节点结构。 */
export interface NamespaceTreeNode {
  title: string;
  label: string;
  value: string;
  key: string;
  fullPath: string;
  isLeaf?: boolean;
  children?: NamespaceTreeNode[];
}

/** 选择器初始化结果。 */
export interface NamespaceEnsureResult {
  valid: boolean;
  group?: GitLabGroup;
  error?: unknown;
  cancelled?: boolean;
}

/** TreeSelect 节点值。 */
type NamespaceNodeValue = string | number | null | undefined;

/**
 * 统一提取分组展示名。
 * @param group GitLab 分组
 * @returns 分组显示名
 */
const getGroupTitle = (group: GitLabGroup): string => {
  return group.name || group.full_path?.split('/').pop() || group.path || String(group.id);
};

/**
 * 统一提取分组完整展示名，优先使用 GitLab 中文层级名称。
 * @param group GitLab 分组
 * @returns 分组完整显示名
 */
const getGroupDisplayPath = (group: GitLabGroup): string => {
  return group.full_name || group.name || group.full_path || group.path || String(group.id);
};

/**
 * 统一提取 Namespace 展示名。
 * @param namespace GitLab Namespace
 * @returns Namespace 显示名
 */
const getNamespaceTitle = (namespace: GitLabNamespace): string => {
  return namespace.name || namespace.full_path?.split('/').pop() || namespace.path || String(namespace.id);
};

/**
 * 将 GitLab Group 映射为 TreeSelect 节点。
 * @param group GitLab 分组
 * @returns TreeSelect 节点
 */
const mapGroupToNode = (group: GitLabGroup): NamespaceTreeNode => {
  const fullPath = group.full_path || group.path || getGroupTitle(group);
  const displayPath = getGroupDisplayPath(group);
  return {
    title: getGroupTitle(group),
    label: displayPath,
    value: String(group.id),
    key: String(group.id),
    fullPath,
    isLeaf: false,
  };
};

/**
 * 将 Namespace 映射为等价的 Group 节点。
 * @param namespace GitLab Namespace
 * @returns TreeSelect 节点
 */
const mapNamespaceToNode = (namespace: GitLabNamespace): NamespaceTreeNode => {
  const fullPath = namespace.full_path || namespace.path || namespace.name || String(namespace.id);
  const title = getNamespaceTitle(namespace);
  return {
    title,
    label: title,
    value: String(namespace.id),
    key: String(namespace.id),
    fullPath,
    isLeaf: true,
  };
};

/**
 * 根据 full_path 对节点去重排序。
 * @param nodes TreeSelect 节点列表
 * @returns 去重排序后的节点列表
 */
const normalizeNodes = (nodes: NamespaceTreeNode[]): NamespaceTreeNode[] => {
  const nodeMap = new Map<string, NamespaceTreeNode>();

  for (const node of nodes) {
    const key = node.fullPath || node.value;
    const existing = nodeMap.get(key);

    if (!existing) {
      nodeMap.set(key, node);
      continue;
    }

    const preferredStructure =
      existing.isLeaf === false
        ? existing
        : node.isLeaf === false || node.label.length >= existing.label.length
          ? node
          : existing;
    const preferredLabel = node.label.length > existing.label.length ? node : existing;
    nodeMap.set(key, {
      ...preferredStructure,
      label: preferredLabel.label,
      title: preferredStructure.isLeaf === false ? preferredStructure.title : preferredLabel.title,
      fullPath: preferredLabel.fullPath || preferredStructure.fullPath,
      isLeaf: existing.isLeaf === false || node.isLeaf === false ? false : (preferredStructure.isLeaf ?? preferredLabel.isLeaf),
      children: existing.children || node.children,
    });
  }

  return Array.from(nodeMap.values()).sort((a, b) => a.fullPath.localeCompare(b.fullPath, 'zh-Hans-CN'));
};

/**
 * GitLab Namespace 选择器数据管理。
 * @returns Namespace 选择器状态与事件
 */
export const useGitlabNamespaces = () => {
  const treeRequestCount = ref(0);
  const searchLoading = ref(false);
  const treeData = ref<NamespaceTreeNode[]>([]);
  const searchTreeData = ref<NamespaceTreeNode[]>([]);
  const selectedNodeMap = ref<Map<string, NamespaceTreeNode>>(new Map());
  const groupDetailMap = ref<Map<string, GitLabGroup>>(new Map());
  const expandedKeys = ref<string[]>([]);
  const topGroupsLoaded = ref(false);
  const searchValue = ref('');
  const searchError = ref('');
  const searchHasMore = ref(false);

  let searchTimer: number | null = null;
  let searchRequestSeq = 0;
  let cacheGeneration = 0;

  const treeLoading = computed(() => treeRequestCount.value > 0);
  const loading = computed(() => treeLoading.value || searchLoading.value);
  const isSearching = computed(() => !!searchValue.value.trim());
  const displayTreeData = computed(() => (isSearching.value ? searchTreeData.value : treeData.value));
  const searchStatusText = computed(() => {
    if (!isSearching.value) return '';
    if (searchLoading.value) return '正在搜索 GitLab 分组...';
    if (searchError.value) return searchError.value;
    if (searchHasMore.value) return '搜索结果较多，请输入更精确的关键词继续缩小范围';
    if (!searchTreeData.value.length) return '未找到匹配的 GitLab Group';
    return '';
  });

  /** 标记一个树数据请求开始。 */
  const startTreeRequest = () => {
    treeRequestCount.value += 1;
  };

  /** 标记一个树数据请求结束。 */
  const finishTreeRequest = () => {
    treeRequestCount.value = Math.max(0, treeRequestCount.value - 1);
  };

  /**
   * 判断异步结果是否仍属于当前 GitLab 账号上下文。
   * @param generation 请求发起时的上下文版本
   * @returns 是否仍可写入状态
   */
  const isCurrentGeneration = (generation: number): boolean => generation === cacheGeneration;

  /**
   * 写入已知节点缓存，保证选中态可以显示 full_path。
   * @param nodes 节点列表
   */
  const cacheNodes = (nodes: NamespaceTreeNode[]) => {
    const next = new Map(selectedNodeMap.value);
    for (const node of nodes) {
      next.set(node.value, node);
    }
    selectedNodeMap.value = next;
  };

  /**
   * 写入 GitLab 分组详情缓存，用于追溯父级链路。
   * @param groups GitLab 分组列表
   */
  const cacheGroups = (groups: GitLabGroup[]) => {
    const next = new Map(groupDetailMap.value);
    for (const group of groups) {
      next.set(String(group.id), group);
    }
    groupDetailMap.value = next;
  };

  /**
   * 将已知节点合并到基础树，确保选中值能稳定展示 label。
   * @param nodes 节点列表
   */
  const mergeTreeRootNodes = (nodes: NamespaceTreeNode[]) => {
    treeData.value = normalizeNodes([...treeData.value, ...nodes]);
  };

  /**
   * 在当前树中查找节点。
   * @param nodes 节点列表
   * @param value 节点值
   * @returns 匹配节点
   */
  const findNodeByValue = (nodes: NamespaceTreeNode[], value: string): NamespaceTreeNode | undefined => {
    for (const node of nodes) {
      if (node.value === value) return node;
      const found = node.children ? findNodeByValue(node.children, value) : undefined;
      if (found) return found;
    }
    return undefined;
  };

  /**
   * 为指定父节点写入子节点。
   * @param nodes 节点列表
   * @param parentValue 父节点值
   * @param children 子节点列表
   * @returns 更新后的节点列表
   */
  const setNodeChildren = (nodes: NamespaceTreeNode[], parentValue: string, children: NamespaceTreeNode[]): NamespaceTreeNode[] => {
    return nodes.map((node) => {
      if (node.value === parentValue) {
        return {
          ...node,
          isLeaf: false,
          children: normalizeNodes([...(node.children || []), ...children]),
        };
      }

      if (!node.children) return node;
      return {
        ...node,
        children: setNodeChildren(node.children, parentValue, children),
      };
    });
  };

  /**
   * 统一提取节点值字符串。
   * @param value TreeSelect 节点值
   * @returns 字符串值
   */
  const normalizeNodeValue = (value?: NamespaceNodeValue): string => {
    if (value === null || value === undefined) return '';
    return String(value);
  };

  /**
   * 加载顶层 Group。
   */
  const loadTopGroups = async () => {
    if (topGroupsLoaded.value) return;
    const generation = cacheGeneration;
    startTreeRequest();
    try {
      const groups = await getTopLevelGroups();
      if (!isCurrentGeneration(generation)) return;
      const nodes = normalizeNodes(groups.map(mapGroupToNode));
      cacheGroups(groups);
      mergeTreeRootNodes(nodes);
      cacheNodes(nodes);
      topGroupsLoaded.value = true;
    } catch (error) {
      if (isCurrentGeneration(generation)) {
        message.error(error instanceof Error ? error.message : '加载 GitLab 顶层分组失败');
      }
    } finally {
      finishTreeRequest();
    }
  };

  /**
   * 加载指定 Group 的直接子组。
   * @param parentId 父级 Group ID
   * @returns 子节点
   */
  const loadChildren = async (parentId: number): Promise<NamespaceTreeNode[]> => {
    const generation = cacheGeneration;
    startTreeRequest();
    try {
      const groups = await getGroupSubgroups(parentId);
      if (!isCurrentGeneration(generation)) return [];
      const nodes = normalizeNodes(groups.map(mapGroupToNode));
      cacheGroups(groups);
      cacheNodes(nodes);
      return nodes;
    } finally {
      finishTreeRequest();
    }
  };

  /**
   * 加载并写入指定父节点的子节点。
   * @param parentId 父级 Group ID
   * @returns 子节点
   */
  const loadAndAttachChildren = async (parentId: number): Promise<NamespaceTreeNode[]> => {
    const generation = cacheGeneration;
    const parentValue = String(parentId);
    const existing = findNodeByValue(treeData.value, parentValue);
    if (existing?.children?.length) return existing.children;

    const nodes = await loadChildren(parentId);
    if (!isCurrentGeneration(generation)) return [];
    treeData.value = setNodeChildren(treeData.value, parentValue, nodes);
    return nodes;
  };

  /**
   * 读取 GitLab 分组详情并使用缓存减少重复请求。
   * @param groupId Group ID
   * @returns GitLab 分组详情
   */
  const getCachedGroupById = async (groupId: number): Promise<GitLabGroup> => {
    const cached = groupDetailMap.value.get(String(groupId));
    if (cached) return cached;

    const generation = cacheGeneration;
    const group = await getGroupById(groupId);
    if (isCurrentGeneration(generation)) {
      cacheGroups([group]);
      cacheNodes([mapGroupToNode(group)]);
    }
    return group;
  };

  /**
   * 获取从根节点到目标节点的 Group 链路。
   * @param groupId 目标 Group ID
   * @returns 根到目标的分组链路
   */
  const getGroupPath = async (groupId: number): Promise<GitLabGroup[]> => {
    const path: GitLabGroup[] = [];
    let currentId: number | null = groupId;

    while (currentId) {
      const group = await getCachedGroupById(currentId);
      path.unshift(group);
      currentId = group.parent_id;
    }

    return path;
  };

  /**
   * 搜索 GitLab Group Namespace。
   * @param keyword 搜索关键词
   * @param requestSeq 请求序号
   */
  const runSearch = async (keyword: string, requestSeq: number) => {
    const text = keyword.trim();

    if (!text) {
      searchTreeData.value = [];
      searchError.value = '';
      searchHasMore.value = false;
      return;
    }

    searchLoading.value = true;
    searchError.value = '';

    try {
      const namespaceResult = await searchNamespacesPaged(
        text,
        {
          full_path_search: true,
          per_page: 100,
        },
        SEARCH_MAX_PAGES
      );
      const groupNamespaces = namespaceResult.items.filter((item) => item.kind === 'group');
      const namespaceNodes = groupNamespaces.map(mapNamespaceToNode);

      const groupResult = await searchGroupsPaged(
        text,
        {
          all_available: true,
          with_projects: false,
          per_page: 100,
        },
        SEARCH_MAX_PAGES
      );
      const groupNodes = groupResult.items.map((group) => ({
        ...mapGroupToNode(group),
        title: getGroupDisplayPath(group),
        isLeaf: true,
      }));

      if (requestSeq !== searchRequestSeq) return;

      const nodes = normalizeNodes([...namespaceNodes, ...groupNodes]);
      searchTreeData.value = nodes;
      searchHasMore.value = namespaceResult.hasMore || groupResult.hasMore;
      cacheNodes(nodes);
    } catch (error) {
      if (requestSeq !== searchRequestSeq) return;
      searchTreeData.value = [];
      searchError.value = error instanceof Error ? error.message : '搜索 GitLab 分组失败';
    } finally {
      if (requestSeq === searchRequestSeq) {
        searchLoading.value = false;
      }
    }
  };

  /**
   * TreeSelect 搜索事件。
   * @param keyword 搜索关键词
   */
  const onTreeSearch = (keyword: string) => {
    searchValue.value = keyword;

    if (searchTimer !== null) {
      window.clearTimeout(searchTimer);
      searchTimer = null;
    }

    const requestSeq = (searchRequestSeq += 1);
    searchTimer = window.setTimeout(() => {
      void runSearch(keyword, requestSeq);
    }, SEARCH_DEBOUNCE_MS);
  };

  /**
   * 下拉展开事件。
   * @param open 是否展开
   */
  const onTreeDropdownVisibleChange = async (open: boolean) => {
    if (open && !isSearching.value) {
      await loadTopGroups();
    }
  };

  /**
   * 展开树到指定 Namespace 节点。
   * @param id Namespace ID
   */
  const expandToNamespace = async (id?: number | string | null) => {
    const groupId = Number(id);
    if (!groupId || Number.isNaN(groupId)) return;

    const generation = cacheGeneration;
    startTreeRequest();
    try {
      await loadTopGroups();
      if (!isCurrentGeneration(generation)) return;
      const path = await getGroupPath(groupId);
      if (!isCurrentGeneration(generation)) return;
      const parentPath = path.slice(0, -1);

      for (const group of parentPath) {
        await loadAndAttachChildren(group.id);
        if (!isCurrentGeneration(generation)) return;
      }

      cacheNodes(path.map(mapGroupToNode));
      expandedKeys.value = parentPath.map((group) => String(group.id));
    } catch (error) {
      if (isCurrentGeneration(generation)) {
        message.warning(error instanceof Error ? error.message : '定位默认 Namespace 失败');
      }
    } finally {
      finishTreeRequest();
    }
  };

  /**
   * 处理 TreeSelect 展开节点变化。
   * @param keys 展开的节点 key
   */
  const handleTreeExpand = (keys: Array<string | number>) => {
    expandedKeys.value = keys.map(String);
  };

  /**
   * 确保默认 namespace id 可显示；无权限或不存在时返回 invalid。
   * @param id Namespace ID
   * @returns 初始化结果
   */
  const ensureOptionForId = async (id?: number | string | null): Promise<NamespaceEnsureResult> => {
    const groupId = Number(id);
    if (!groupId || Number.isNaN(groupId)) {
      return { valid: false, error: { code: 'INVALID_NAMESPACE_ID' } };
    }

    const cached = selectedNodeMap.value.get(String(groupId));
    if (cached) {
      return { valid: true };
    }

    const generation = cacheGeneration;
    startTreeRequest();
    try {
      const group = await getGroupById(groupId);
      if (!isCurrentGeneration(generation)) {
        return { valid: false, cancelled: true };
      }
      const node = mapGroupToNode(group);
      cacheGroups([group]);
      cacheNodes([node]);
      return { valid: true, group };
    } catch (error) {
      if (!isCurrentGeneration(generation)) {
        return { valid: false, cancelled: true };
      }
      return { valid: false, error };
    } finally {
      finishTreeRequest();
    }
  };

  /**
   * 读取选中值的展示路径。
   * @param id Namespace ID
   * @returns full_path
   */
  const getLabelById = (id?: number | string | null): string => {
    const value = normalizeNodeValue(id);
    if (!value) return '';
    const node = selectedNodeMap.value.get(value);
    return node?.label || node?.fullPath || '';
  };

  /**
   * 清空 TreeSelect 搜索态。
   */
  const clearSearch = () => {
    searchValue.value = '';
    searchTreeData.value = [];
    searchError.value = '';
    searchHasMore.value = false;
    searchRequestSeq += 1;
    if (searchTimer !== null) {
      window.clearTimeout(searchTimer);
      searchTimer = null;
    }
  };

  /**
   * 按账号上下文清空缓存。
   */
  const resetNamespaceCache = () => {
    cacheGeneration += 1;
    clearSearch();
    treeData.value = [];
    selectedNodeMap.value = new Map();
    groupDetailMap.value = new Map();
    expandedKeys.value = [];
    topGroupsLoaded.value = false;
  };

  return {
    loading,
    treeLoading,
    searchLoading,
    displayTreeData,
    expandedKeys,
    searchStatusText,
    isSearching,
    loadTopGroups,
    loadChildren,
    onTreeSearch,
    onTreeDropdownVisibleChange,
    handleTreeExpand,
    expandToNamespace,
    ensureOptionForId,
    getLabelById,
    clearSearch,
    resetNamespaceCache,
  };
};
