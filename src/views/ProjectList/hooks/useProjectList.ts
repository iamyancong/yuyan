import { ref, reactive, watch } from 'vue';
import message from 'ant-design-vue/es/message';
import type { YTableColumn } from '@ycwang-dev/components/lite';
import { useAuth } from '@/composables/useAuth';
import { getProjects, type GitLabProject, type GroupTreeNode, type ProjectSearchParams } from '@/api/gitlab';

export const useProjectList = () => {
  // 认证
  const { isLoggedIn, authLoading, authState } = useAuth();

  // 表格列
  const columns: YTableColumn[] = [
    { title: '项目名称', field: 'name', minWidth: 430, fixed: 'left' },
    { title: '项目ID', field: 'id', width: 110, sortable: true, align: 'center' },
    { title: '仓库路径', field: 'path_with_namespace', minWidth: 360 },
    { title: '默认分支', field: 'default_branch', width: 130, align: 'center' },
    { title: '可见性', field: 'visibility', width: 110, align: 'center' },
    { title: '最后活动', field: 'last_activity_at', width: 150, sortable: true },
    { title: '创建时间', field: 'created_at', width: 150, sortable: true },
  ];

  // 状态
  const loading = ref(false);
  const dataSource = ref<(GitLabProject | GroupTreeNode)[]>([]);
  const expandedRowKeys = ref<number[]>([]);
  const gitopsVisible = ref(false);
  const gitopsAppName = ref('');
  const gitopsDescription = ref('');
  const gitopsSourceProjectPath = ref('');
  const gitopsSourceProjectId = ref<number | null>(null);

  // 分页
  const pagination = reactive({
    current: 1,
    pageSize: 20,
    total: 0,
    showSizeChanger: true,
    showQuickJumper: true,
    showTotal: (total: number, range: [number, number]) => `第 ${range[0]}-${range[1]} 条，共 ${total} 条`,
  });

  // 搜索表单
  const searchForm = reactive<ProjectSearchParams>({
    search: '',
    id: undefined,
    visibility: undefined,
    owned: true,
    page: 1,
    per_page: 20,
    order_by: 'last_activity_at',
    sort: 'desc',
  });

  // 行为
  const handleSearch = async (resetCurrent = true) => {
    if (!isLoggedIn.value) {
      window.dispatchEvent(new CustomEvent('show-login-modal'));
      return;
    }

    loading.value = true;
    if (resetCurrent) pagination.current = 1;

    try {
      const params: ProjectSearchParams = {
        page: pagination.current,
        per_page: pagination.pageSize,
        order_by: searchForm.order_by || 'last_activity_at',
        sort: searchForm.sort || 'desc',
      };

      if (searchForm.search && String(searchForm.search).trim()) {
        params.search = String(searchForm.search).trim();
      }

      // 服务端可用的筛选项
      if (searchForm.id) params.id = searchForm.id;
      if (typeof searchForm.owned !== 'undefined') params.owned = searchForm.owned;
      if (searchForm.visibility) params.visibility = searchForm.visibility;
      if (typeof (searchForm as any).membership !== 'undefined') params.membership = (searchForm as any).membership;
      if (typeof (searchForm as any).starred !== 'undefined') params.starred = (searchForm as any).starred;
      if (typeof (searchForm as any).archived !== 'undefined') params.archived = (searchForm as any).archived;

      // creator 客户端拼到 search 里（GitLab API 不直接支持）
      if ((searchForm as any).creator && String((searchForm as any).creator).trim()) {
        const creator = String((searchForm as any).creator).trim();
        params.search = (params.search ? params.search + ' ' : '') + creator;
      }

      const projects = await getProjects(params);

      let filtered = projects;
      if (searchForm.id) {
        filtered = filtered.filter((p) => p.id === searchForm.id);
      }

      if ((searchForm as any).tagList && String((searchForm as any).tagList).trim()) {
        const tags = String((searchForm as any).tagList)
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
        if (tags.length > 0) {
          filtered = filtered.filter((p) => tags.some((t) => p.topics?.includes(t) || p.tag_list?.includes(t)));
        }
      }

      dataSource.value = filtered;
      pagination.total = filtered.length; // 简化：真实项目可从响应头读取

      if (filtered.length === 0) {
        message.info('未找到符合条件的项目');
      } else {
        message.success(`找到 ${filtered.length} 个项目`);
      }
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '搜索失败');
    } finally {
      loading.value = false;
    }
  };

  const handleReset = () => {
    Object.assign(searchForm, {
      search: '',
      id: undefined,
      visibility: undefined,
      owned: true,
      page: 1,
      per_page: 20,
      order_by: 'last_activity_at',
      sort: 'desc',
    } as ProjectSearchParams);
    handleSearch();
  };

  /** 清空当前项目列表数据 */
  const clearData = () => {
    dataSource.value = [];
    expandedRowKeys.value = [];
    pagination.total = 0;
  };

  const handleRefresh = () => {
    handleSearch();
  };

  const handleTableChange = (paginationInfo: any, _filters: any, sorter: any) => {
    pagination.current = paginationInfo.current;
    pagination.pageSize = paginationInfo.pageSize;
    if (sorter.field && sorter.order) {
      searchForm.order_by = sorter.field;
      searchForm.sort = sorter.order === 'ascend' ? 'asc' : 'desc';
    }
    handleSearch(false);
  };

  const toggleGroupExpand = (record: GroupTreeNode) => {
    const index = expandedRowKeys.value.indexOf(record.id);
    if (index > -1) {
      expandedRowKeys.value.splice(index, 1);
      record.isExpanded = false;
    } else {
      expandedRowKeys.value.push(record.id);
      record.isExpanded = true;
    }
  };

  const loadGroupProjects = async (_group: GroupTreeNode) => {
    // 预留：按需加载分组项目
  };

  const handleExpand = (expanded: boolean, record: GitLabProject | GroupTreeNode) => {
    if ('isGroup' in record && record.isGroup && expanded) {
      loadGroupProjects(record as GroupTreeNode);
    }
  };

  const onOpenGitOps = (record: GitLabProject | GroupTreeNode) => {
    if ('isGroup' in record) return;
    const repo = record as GitLabProject;
    gitopsAppName.value = repo.path || '';
    gitopsDescription.value = repo.description || '';
    gitopsSourceProjectPath.value = repo.path_with_namespace || '';
    gitopsSourceProjectId.value = repo.id || null;
    gitopsVisible.value = true;
  };

  const initAuthCheck = async () => {
    if (authLoading.value) {
      let attempts = 0;
      const maxAttempts = 50;
      while (authLoading.value && attempts < maxAttempts) {
        await new Promise((r) => setTimeout(r, 100));
        attempts += 1;
      }
    }
    authReady = true;
    return isLoggedIn.value;
  };

  // 登录后自动刷新
  let authReady = false;
  watch(isLoggedIn, (nv, ov) => {
    if (!nv) {
      clearData();
      return;
    }
    if (nv && !ov && authReady) {
      handleSearch();
    }
  });

  return {
    // 认证
    isLoggedIn,
    authLoading,
    authState,

    // 列配置
    columns,

    // 状态
    loading,
    dataSource,
    expandedRowKeys,
    pagination,
    searchForm,

    // GitOps 弹窗
    gitopsVisible,
    gitopsAppName,
    gitopsDescription,
    gitopsSourceProjectPath,
    gitopsSourceProjectId,

    // 行为
    handleSearch,
    handleReset,
    handleRefresh,
    clearData,
    handleTableChange,
    toggleGroupExpand,
    handleExpand,
    onOpenGitOps,
    initAuthCheck,
  };
};

export type UseProjectListReturn = ReturnType<typeof useProjectList>;
