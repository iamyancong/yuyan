<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { YTable } from '@ycwang-dev/components/lite';
import { openExternal } from '@/utils/open';
import { useTableHeight } from '@ycwang-dev/hooks';
import type { YTableActionConfig } from '@ycwang-dev/components/lite';
import type { DeployRecord } from '@/api/deploy';
import {
  getDeployRecordCommitMessage,
  getDeployRecordShortCommit,
  getDeployRecordStatusColor,
  getDeployRecordStatusLabel,
  recordColumns,
} from '../../constant';
import type { RecordProjectOption, RecordServerOption } from '../../types';
import DeployRecordFilterBar from './components/DeployRecordFilterBar.vue';

defineOptions({ name: 'DeployRecordTab' });

/** 表格默认高度 */
const TABLE_DEFAULT_HEIGHT = 420;

/** 表格最小高度 */
const TABLE_MIN_HEIGHT = 240;

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
  projectFilter: string;
  branchFilter?: string;
  serverOptions: RecordServerOption[];
  projectOptions: RecordProjectOption[];
  branchOptions: SelectOption[];
  pagination: RecordPagination;
}

const props = defineProps<DeployRecordTabProps>();

const emit = defineEmits<{
  (e: 'serverChange', value?: number): void;
  (e: 'projectChange', value: string): void;
  (e: 'branchChange', value?: string): void;
  (e: 'pageChange', value: { current: number; pageSize: number }): void;
  (e: 'refresh'): void;
}>();

const tableAreaRef = ref<HTMLElement>();
const { tableHeight: rawTableHeight, recalculateHeight } = useTableHeight(tableAreaRef, {
  minHeight: TABLE_MIN_HEIGHT,
  defaultHeight: TABLE_DEFAULT_HEIGHT,
  withPagination: true,
});

/** 限制表格最小高度，避免 hook 内部 availableHeight <= minHeight 时 fallback 到 0 的 Bug */
const tableHeight = computed(() => {
  return rawTableHeight.value > TABLE_MIN_HEIGHT ? rawTableHeight.value : TABLE_MIN_HEIGHT;
});

/** 等待视图更新后重新计算表格高度 */
const recalculateAfterRender = async () => {
  await nextTick();
  recalculateHeight();
};

watch([() => props.loading, () => props.records.length, () => props.pagination.pageSize], recalculateAfterRender, {
  flush: 'post',
});

watch(
  () => props.active,
  (isActive) => {
    if (isActive) {
      void recalculateAfterRender();
    }
  },
  { flush: 'post' }
);

/**
 * 构建 GitLab 提交记录页面链接。
 * @param record 发布记录
 * @returns 提交记录页面链接，无法获取时返回空字符串
 */
const buildCommitUrl = (record: DeployRecord): string => {
  const commitSha = record.commitSha;
  if (!commitSha) return '';

  const gitlabHost = localStorage.getItem('gitlab-host') || import.meta.env.VITE_GITLAB_HOST || '';
  const host = gitlabHost.replace(/\/+$/, '').replace(/\/api\/v4$/, '');
  const projectPath = record.projectPath || '';

  if (projectPath) {
    return `${host}/${projectPath}/-/commit/${commitSha}`;
  }

  const repoUrl = record.repositoryUrl || '';
  if (repoUrl) {
    if (repoUrl.startsWith('http://') || repoUrl.startsWith('https://')) {
      const baseUrl = repoUrl.replace(/\.git$/i, '');
      return `${baseUrl}/-/commit/${commitSha}`;
    }
    if (repoUrl.includes('@')) {
      const match = repoUrl.match(/@([^:/]+)(?::\d+)?[:/](.+)$/i);
      if (match) {
        const hostName = match[1];
        const repoPath = match[2].replace(/\.git$/i, '');
        let portPart = '';
        try {
          const urlObj = new URL(host);
          if (urlObj.port) portPart = `:${urlObj.port}`;
        } catch (e) {}
        return `${host.startsWith('https') ? 'https' : 'http'}://${hostName}${portPart}/${repoPath}/-/commit/${commitSha}`;
      }
    }
  }

  return '';
};

const commitUrlMap = computed(() => {
  const map = new Map<number, string>();
  props.records.forEach((record) => {
    map.set(record.id, buildCommitUrl(record));
  });
  return map;
});

/**
 * 获取当前行的 GitLab 提交链接。
 * @param record 发布记录
 */
const getCommitUrl = (record: DeployRecord) => commitUrlMap.value.get(record.id) || '';
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
      @project-change="(val: string) => emit('projectChange', val)"
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
        :pageable="true"
        :pagination="pagination"
        size="small"
        id="nginx-deploy-records"
        @page-change="(pageInfo: { current: number; pageSize: number }) => emit('pageChange', pageInfo)"
      >
        <template #status="{ row }">
          <a-tag :color="getDeployRecordStatusColor(row.status)">
            {{ getDeployRecordStatusLabel(row.status) }}
          </a-tag>
        </template>
        <template #effectiveCommit="{ row }">
          <a-space :size="6">
            <a v-if="getCommitUrl(row)" :href="getCommitUrl(row)" class="commit-link" @click.prevent.stop="openExternal(getCommitUrl(row))">
              {{ getDeployRecordShortCommit(row) }}
            </a>
            <span v-else>{{ getDeployRecordShortCommit(row) }}</span>
            <a-tag v-if="row.isCurrentVersion" color="processing">当前</a-tag>
          </a-space>
        </template>
        <template #commitMessage="{ row }">
          <a v-if="getCommitUrl(row)" :href="getCommitUrl(row)" class="commit-link" @click.prevent.stop="openExternal(getCommitUrl(row))">
            {{ getDeployRecordCommitMessage(row) }}
          </a>
          <span v-else>{{ getDeployRecordCommitMessage(row) || '-' }}</span>
        </template>
      </YTable>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
