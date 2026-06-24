<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { YCard } from '@yss-ui/components/lite';
import '@yss-ui/components/dist/style.css';
import ProjectSearchForm from '@/views/ProjectList/components/SearchForm.vue';
import ProjectTable from '@/views/ProjectList/components/ProjectTable.vue';
import type { GitLabProject } from '@/api/gitlab';
import { useYssVxeUI } from '@/composables/useYssVxeUI';
import { useOpsProjectList } from './hooks/useOpsProjectList';
import { useProjectTableHeight } from '@/views/ProjectList/hooks/useProjectTableHeight';

defineOptions({ name: 'OpsProjectList' });

useYssVxeUI();

/** GitOps 配置弹窗依赖编辑器，仅在需要时加载 */
const GitOpsConfigModal = defineAsyncComponent(() => import('@/components/GitOpsConfigModal/index.vue'));

/** 项目代码抽屉依赖 Monaco，仅在查看代码时加载 */
const ProjectCodeDrawer = defineAsyncComponent(() => import('./components/ProjectCodeDrawer.vue'));

const router = useRouter();

const {
  // 列与数据
  columns,
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
  handleTableChange,
  onOpenGitOps,
  initAuthCheck,
} = useOpsProjectList();

const codeDrawerVisible = ref(false);
const currentExportProject = ref<{ id: number; name: string; branch: string }>({
  id: 0,
  name: '',
  branch: 'dev',
});

const dataLength = computed(() => dataSource.value.length);
const pageSize = computed(() => pagination.pageSize);
const { tableBoundaryRef, tableAreaRef, tableHeight, recalculateHeight } = useProjectTableHeight(loading, dataLength, pageSize);

/**
 * 打开项目代码抽屉。
 * @param record - GitLab 项目记录
 */
const handleOpenCodeDrawer = (record: GitLabProject) => {
  currentExportProject.value = {
    id: record.id,
    name: record.name,
    branch: record.default_branch || 'dev',
  };
  codeDrawerVisible.value = true;
};

/**
 * 跳转到独立服务器部署中心
 * @param record - GitLab 项目记录
 */
const handleOpenNginxDeploy = (record: GitLabProject) => {
  router.push({
    path: '/nginx-deploy',
    query: {
      projectId: String(record.id),
      projectName: record.name,
      projectDescription: record.description || '',
      projectPath: record.path_with_namespace,
      repositoryUrl: record.http_url_to_repo,
      defaultBranch: record.default_branch || 'dev',
    },
  });
};

onMounted(async () => {
  const loggedIn = await initAuthCheck();
  if (loggedIn) {
    handleSearch();
  } else {
    window.dispatchEvent(new CustomEvent('show-login-modal'));
  }
  recalculateHeight();
});

</script>

<template>
  <div ref="tableBoundaryRef" class="project-list-boundary">
    <YCard class="project-list-page ops-project-list-page" :padding="14">
      <template #title>
        <div class="project-list-title">
          <span>平台应用列表</span>
          <em>yuyan-ops 创建项目</em>
        </div>
      </template>
      <ProjectSearchForm
        :model-value="searchForm"
        :loading="loading"
        @update:model-value="(val) => Object.assign(searchForm, val)"
        @submit="handleSearch"
        @reset="handleReset"
        @refresh="handleRefresh"
      />

      <div ref="tableAreaRef" class="project-table-area">
        <ProjectTable
          :columns="columns"
          :data-source="dataSource"
          :loading="loading"
          :pagination="pagination"
          :expanded-row-keys="expandedRowKeys"
          :table-height="tableHeight"
          size="small"
          @change="handleTableChange"
          @openGitOps="onOpenGitOps"
          @viewCode="handleOpenCodeDrawer"
          @openNginxDeploy="handleOpenNginxDeploy"
        />
      </div>
    </YCard>
  </div>

  <GitOpsConfigModal
    v-if="gitopsVisible"
    v-model:open="gitopsVisible"
    :appName="gitopsAppName"
    :description="gitopsDescription"
    :defaultBranch="'dev'"
    :sourceProjectPath="gitopsSourceProjectPath"
    :sourceProjectId="gitopsSourceProjectId || undefined"
  />

  <ProjectCodeDrawer
    v-if="codeDrawerVisible"
    v-model:open="codeDrawerVisible"
    :projectId="currentExportProject.id"
    :projectName="currentExportProject.name"
    :defaultBranch="currentExportProject.branch"
  />
</template>

<style scoped lang="less">
@import '@/views/ProjectList/style.less';
@import './style.less';
</style>
