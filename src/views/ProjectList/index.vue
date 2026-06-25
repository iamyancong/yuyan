<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { YCard } from '@ycwang-dev/components/lite';
import '@ycwang-dev/components/dist/style.css';
import ProjectSearchForm from './components/SearchForm.vue';
import ProjectTable from './components/ProjectTable.vue';
import type { GitLabProject } from '@/api/gitlab';
import { useYssVxeUI } from '@/composables/useYssVxeUI';
import { useProjectList } from './hooks/useProjectList';
import { useProjectTableHeight } from './hooks/useProjectTableHeight';

defineOptions({ name: 'ProjectList' });

useYssVxeUI();

/** GitOps 配置弹窗依赖编辑器，仅在需要时加载 */
const GitOpsConfigModal = defineAsyncComponent(() => import('@/components/GitOpsConfigModal/index.vue'));

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
  toggleGroupExpand,
  handleExpand,
  onOpenGitOps,
  initAuthCheck,
} = useProjectList();

const dataLength = computed(() => dataSource.value.length);
const pageSize = computed(() => pagination.pageSize);
const { tableBoundaryRef, tableAreaRef, tableHeight, recalculateHeight } = useProjectTableHeight(loading, dataLength, pageSize);

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
    <YCard class="project-list-page" :padding="14">
      <template #title>
        <div class="project-list-title">
          <span>GitLab 仓库列表</span>
          <em>全量仓库检索与部署入口</em>
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
          @expand="handleExpand"
          @change="handleTableChange"
          @toggleGroupExpand="toggleGroupExpand"
          @openGitOps="onOpenGitOps"
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
</template>

<style scoped lang="less">
@import './style.less';
</style>
