<script setup lang="ts">
import { toRef } from 'vue';
import { YTable } from '@yss-ui/components/lite';
import type { YTableActionConfig } from '@yss-ui/components/lite';
import type { DeployRecord } from '@/api/deploy';
import { getDeployRecordStatusColor, getDeployRecordStatusLabel, recordColumns } from '../../constant';
import type { RecordProjectOption, RecordServerOption } from '../../types';
import { TABLE_CELL_CONFIG, TABLE_HEADER_HEIGHT } from './constant';
import { useDeployRecordTab } from './hooks/useDeployRecordTab';
import DeployRecordFilterBar from './components/DeployRecordFilterBar.vue';
import NginxProjectNameCell from '../NginxProjectNameCell/index.vue';
import DeployServerCell from '../DeployServerCell/index.vue';
import DeployCommitMessageCell from '../DeployCommitMessageCell/index.vue';
import MiddleEllipsisText from '@/components/MiddleEllipsisText.vue';

defineOptions({ name: 'DeployRecordTab' });

/** 下拉选项 */
interface SelectOption {
  label: string;
  value: string;
}

/** 发布历史分页状态 */
interface RecordPagination {
  current: number;
  pageSize: number;
  total: number;
  remote: boolean;
  responsive: boolean;
  showLessItems: boolean;
  showSizeChanger: boolean;
  showQuickJumper: boolean;
  showTotal: (total: number, range: [number, number]) => string;
}

/** 发布历史 Tab 属性 */
interface DeployRecordTabProps {
  active: boolean;
  loading: boolean;
  records: DeployRecord[];
  actionConfig: YTableActionConfig;
  serverFilter?: number;
  projectFilter?: string;
  branchFilter?: string;
  serverOptions: RecordServerOption[];
  projectOptions: RecordProjectOption[];
  branchOptions: SelectOption[];
  pagination: RecordPagination;
}

const props = defineProps<DeployRecordTabProps>();

const emit = defineEmits<{
  (e: 'serverChange', value?: number): void;
  (e: 'projectChange', value?: string): void;
  (e: 'branchChange', value?: string): void;
  (e: 'pageChange', value: { current: number; pageSize: number }): void;
  (e: 'refresh'): void;
}>();

const { tableAreaRef, tableHeight, getCommitUrl } = useDeployRecordTab({
  active: toRef(props, 'active'),
  loading: toRef(props, 'loading'),
  records: toRef(props, 'records'),
  pageSize: toRef(props.pagination, 'pageSize'),
});
</script>

<template>
  <div class="nginx-deploy-tab-pane">
    <DeployRecordFilterBar
      :loading="loading"
      :server-filter="serverFilter"
      :project-filter="projectFilter"
      :branch-filter="branchFilter"
      :server-options="serverOptions"
      :project-options="projectOptions"
      :branch-options="branchOptions"
      @server-change="(val?: number) => emit('serverChange', val)"
      @project-change="(val?: string) => emit('projectChange', val)"
      @branch-change="(val?: string) => emit('branchChange', val)"
      @refresh="emit('refresh')"
    />
    <div ref="tableAreaRef" class="nginx-deploy-table-area">
      <YTable
        :data="records"
        :columns="recordColumns"
        :loading="loading"
        :action-config="actionConfig"
        :max-height="tableHeight"
        :cell-config="TABLE_CELL_CONFIG"
        :header-height="TABLE_HEADER_HEIGHT"
        :pageable="true"
        :auto-flex-column="false"
        :pagination="pagination"
        size="small"
        id="nginx-deploy-records-v2"
        @page-change="(pageInfo: { current: number; pageSize: number }) => emit('pageChange', pageInfo)"
      >
        <template #projectName="{ row }">
          <NginxProjectNameCell :record="row" />
        </template>
        <template #serverName="{ row }">
          <DeployServerCell :server-name="row.serverName" :server-host="row.serverHost" />
        </template>
        <template #commitMessage="{ row }">
          <DeployCommitMessageCell :record="row" :commit-url="getCommitUrl(row)" />
        </template>
        <template #status="{ row }">
          <a-tag :color="getDeployRecordStatusColor(row.status)">
            {{ getDeployRecordStatusLabel(row.status) }}
          </a-tag>
        </template>
        <template #releasePath="{ row }">
          <MiddleEllipsisText :text="row.releasePath" />
        </template>
      </YTable>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
