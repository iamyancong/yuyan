import { ref, reactive, watch } from 'vue';
import message from 'ant-design-vue/es/message';
import type { YTableColumn } from '@ycwang-dev/components/lite';
import { useAuth } from '@/composables/useAuth';
import { getProjects, type GitLabProject, type GroupTreeNode, type ProjectSearchParams } from '@/api/gitlab';

const CREATED_TOPIC = 'yuyan-ops';

export const useOpsProjectList = () => {
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
    { title: '操作', field: 'actions', width: 150, fixed: 'right', align: 'center' },
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

  // 搜索表单（沿用通用结构，但默认仅查 owned 项目）
  const searchForm = reactive<ProjectSearchParams & { membership?: boolean; topic?: string }>({
    search: '',
    id: undefined,
    visibility: undefined,
    // owned 留空，使用 membership=true 以包含所在分组的项目
    page: 1,
    per_page: 100,
    order_by: 'last_activity_at',
    sort: 'desc',
    membership: true,
    topic: 'yuyan-ops',
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
      const params: ProjectSearchParams & { membership?: boolean; topic?: string } = {
        page: pagination.current,
        per_page: Math.max(20, pagination.pageSize || 20),
        order_by: searchForm.order_by || 'last_activity_at',
        sort: searchForm.sort || 'desc',
      };

      if (searchForm.search && String(searchForm.search).trim()) {
        params.search = String(searchForm.search).trim();
      }
      if (searchForm.id) params.id = searchForm.id;
      if (searchForm.visibility) params.visibility = searchForm.visibility;
      if (typeof (searchForm as any).membership !== 'undefined') params.membership = (searchForm as any).membership;
      if ((searchForm as any).topic) (params as any).topic = (searchForm as any).topic;

      const projects = await getProjects(params);

      // 只保留带有 yuyan-ops 主题/标签 的项目
      let filtered = projects.filter(
        (p) =>
          (Array.isArray((p as any).topics) && (p as any).topics.includes(CREATED_TOPIC)) ||
          (Array.isArray((p as any).tag_list) && (p as any).tag_list.includes(CREATED_TOPIC))
      );

      if (searchForm.id) {
        filtered = filtered.filter((p) => p.id === searchForm.id);
      }

      dataSource.value = filtered;
      pagination.total = filtered.length;

      if (filtered.length === 0) {
        message.info('暂无由平台创建的项目');
      } else {
        message.success(`共 ${filtered.length} 个平台创建项目`);
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

  /** 清空当前平台应用列表数据 */
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
    onOpenGitOps,
    initAuthCheck,
  };
};

export type UseOpsProjectListReturn = ReturnType<typeof useOpsProjectList>;
