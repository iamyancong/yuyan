<script setup lang="ts">
import { computed } from 'vue';
import { YTable } from '@yss-ui/components/lite';
import type { YTableColumn } from '@yss-ui/components/lite';
import type { GitLabProject, GroupTreeNode } from '@/api/gitlab';
import MiddleEllipsisText from '@/components/MiddleEllipsisText.vue';
import ProjectNameCell from './ProjectNameCell.vue';
import ProjectActions from './ProjectActions.vue';

defineOptions({ name: 'ProjectTable' });

interface PaginationLike {
  current: number;
  pageSize: number;
  total: number;
  showSizeChanger?: boolean;
  showQuickJumper?: boolean;
  showTotal?: (total: number, range: [number, number]) => string;
}

const props = defineProps<{
  columns: YTableColumn[];
  dataSource: (GitLabProject | GroupTreeNode)[];
  loading: boolean;
  pagination: PaginationLike;
  expandedRowKeys: number[];
  size?: 'mini' | 'small' | 'medium' | 'large';
  tableHeight?: number;
}>();

const emit = defineEmits<{
  (e: 'expand', expanded: boolean, record: GitLabProject | GroupTreeNode): void;
  (e: 'change', pagination: { current: number; pageSize: number }, filters: any, sorter: any): void;
  (e: 'toggleGroupExpand', record: GroupTreeNode): void;
  (e: 'openGitOps', record: GitLabProject): void;
  (e: 'viewCode', record: GitLabProject): void;
  (e: 'openNginxDeploy', record: GitLabProject): void;
}>();

const tablePagination = computed(() => ({
  ...props.pagination,
  remote: true,
  responsive: true,
  showLessItems: true,
}));

const rowConfig = {
  keyField: 'id',
  useKey: true,
  isCurrent: true,
  isHover: true,
};

/**
 * 格式化 GitLab 日期。
 * @param dateStr - GitLab 时间字符串
 * @returns 中文日期文本
 */
const formatDate = (dateStr: string) => {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
};

const getVisibilityColor = (visibility: string) => {
  const colors: Record<string, string> = { public: 'green', internal: 'blue', private: 'orange' };
  return colors[visibility] || 'default';
};

/**
 * 获取仓库完整路径。
 * @param record - 当前表格行
 * @returns 仓库路径
 */
const getRepositoryPath = (record: GitLabProject | GroupTreeNode) => {
  if ('path_with_namespace' in record) return record.path_with_namespace || '-';
  return record.full_path || record.name || '-';
};

/**
 * 获取默认分支。
 * @param record - 当前表格行
 * @returns 默认分支名称
 */
const getDefaultBranch = (record: GitLabProject | GroupTreeNode) => {
  if ('default_branch' in record) return record.default_branch || '-';
  return '-';
};

const toggleGroup = (record: GroupTreeNode) => emit('toggleGroupExpand', record);

/**
 * 同步分页变化。
 * @param pageInfo - YTable 分页事件参数
 */
const handlePageChange = (pageInfo: { current: number; pageSize: number }) => {
  emit('change', pageInfo, {}, {});
};

/**
 * 同步排序变化。
 * @param sortInfo - vxe-table 排序事件参数
 */
const handleSortChange = (sortInfo: { field?: string; property?: string; order?: string }) => {
  const field = sortInfo.field || sortInfo.property;
  const orderMap: Record<string, string> = { asc: 'ascend', desc: 'descend' };
  emit('change', { current: props.pagination.current, pageSize: props.pagination.pageSize }, {}, { field, order: orderMap[sortInfo.order || ''] });
};
</script>

<template>
  <div class="project-table">
    <YTable
      :columns="props.columns"
      :data="props.dataSource"
      :loading="props.loading"
      :pagination="tablePagination"
      :height="props.tableHeight"
      :row-config="rowConfig"
      :show-action-column="false"
      :auto-flex-column="false"
      :pageable="true"
      :border="'full'"
      :stripe="false"
      :cell-config="{ height: 58 }"
      :header-height="42"
      show-overflow="tooltip"
      :size="props.size || 'small'"
      @page-change="handlePageChange"
      @sort-change="handleSortChange"
    >
      <template #name="{ row }">
        <ProjectNameCell :record="row" @toggle-group="toggleGroup" />
      </template>

      <template #path_with_namespace="{ row }">
        <MiddleEllipsisText :text="getRepositoryPath(row)" />
      </template>

      <template #default_branch="{ row }">
        <a-tag class="branch-tag">{{ getDefaultBranch(row) }}</a-tag>
      </template>

      <template #visibility="{ row }">
        <a-tag :color="getVisibilityColor(row.visibility)" class="plain-tag">{{ row.visibility || '-' }}</a-tag>
      </template>

      <template #created_at="{ row }">{{ formatDate(row.created_at) }}</template>

      <template #last_activity_at="{ row }">{{ formatDate(row.last_activity_at) }}</template>

      <template #actions="{ row }">
        <ProjectActions
          :record="row"
          @open-git-ops="(record) => emit('openGitOps', record)"
          @view-code="(record) => emit('viewCode', record)"
          @open-nginx-deploy="(record) => emit('openNginxDeploy', record)"
        />
      </template>
    </YTable>
  </div>
</template>

<style scoped lang="less">
@import './project-table.less';
</style>
