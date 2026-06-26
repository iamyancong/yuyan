<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { YCard, YTable, YButton } from '@ycwang-dev/components/lite';
import { openExternal } from '@/utils/open';
import { useTableHeight } from '@ycwang-dev/hooks';
import { SyncOutlined } from '@ant-design/icons-vue';
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
const { tableHeight, recalculateHeight } = useTableHeight(tableAreaRef, {
  minHeight: TABLE_MIN_HEIGHT,
  defaultHeight: TABLE_DEFAULT_HEIGHT,
  withPagination: true,
});

/** 等待视图更新后重新计算表格高度 */
const recalculateAfterRender = async () => {
  await nextTick();
  recalculateHeight();
};

watch([() => props.loading, () => props.records.length, () => props.pagination.pageSize], recalculateAfterRender, {
  flush: 'post',
});

/**
 * 获取 GitLab 提交记录页面链接。
 * @param record 发布记录
 * @returns 提交记录页面链接，无法获取时返回空字符串
 */
const getCommitUrl = (record: DeployRecord): string => {
  const commitSha = record.commitSha;
  if (!commitSha) return '';

  // 1. 优先使用数据库中存储的 projectPath 拼接本地配置的 GitLab Host
  const gitlabHost = localStorage.getItem('gitlab-host') || 'http://192.168.167.142:8081';
  const host = gitlabHost.replace(/\/+$/, '').replace(/\/api\/v4$/, '');
  const projectPath = record.projectPath || '';

  if (projectPath) {
    return `${host}/${projectPath}/-/commit/${commitSha}`;
  }

  // 2. 兜底逻辑：尝试解析 repositoryUrl
  const repoUrl = record.repositoryUrl || '';
  if (repoUrl) {
    if (repoUrl.startsWith('http://') || repoUrl.startsWith('https://')) {
      const baseUrl = repoUrl.replace(/\.git$/i, '');
      return `${baseUrl}/-/commit/${commitSha}`;
    } else if (repoUrl.includes('@')) {
      const match = repoUrl.match(/@([^:/]+)(?::\d+)?[:/](.+)$/i);
      if (match) {
        const hostName = match[1];
        const repoPath = match[2].replace(/\.git$/i, '');
        // 尝试从 host 中提取端口
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
</script>

<template>
  <YCard class="nginx-deploy-tab-card" :padding="12">
    <div class="record-filter-bar">
      <div class="record-filter-bar__left">
        <a-space>
          <span class="record-filter-bar__label">服务器</span>
          <a-select
            :value="serverFilter"
            class="record-filter-bar__server-select project-select"
            :options="serverOptions"
            :disabled="!serverOptions.length"
            show-search
            option-filter-prop="searchKey"
            option-label-prop="title"
            placeholder="请选择服务器"
            :dropdown-match-select-width="300"
            popup-class-name="project-select-dropdown"
            @change="(value?: number) => emit('serverChange', value)"
          />
          <span class="record-filter-bar__label">项目</span>
          <a-select
            :value="projectFilter"
            class="record-filter-bar__select project-select"
            :options="projectOptions"
            :disabled="!projectOptions.length"
            show-search
            option-filter-prop="searchKey"
            option-label-prop="title"
            popup-class-name="project-select-dropdown"
            placeholder="请选择已配置项目"
            @change="(value: string) => emit('projectChange', value)"
          />
          <span class="record-filter-bar__label">分支</span>
          <a-select
            :value="branchFilter"
            class="record-filter-bar__branch-select project-select"
            :options="branchOptions"
            :disabled="!branchOptions.length"
            allow-clear
            show-search
            option-filter-prop="searchKey"
            option-label-prop="title"
            placeholder="全部分支"
            popup-class-name="project-select-dropdown"
            @change="(value?: string) => emit('branchChange', value)"
          />
        </a-space>
      </div>
      <div class="record-filter-bar__right">
        <YButton :loading="loading" @click="emit('refresh')">
          <template #icon>
            <SyncOutlined v-if="!loading" />
          </template>
          刷新
        </YButton>
      </div>
    </div>
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
  </YCard>
</template>

<style scoped lang="less">
@import './style.less';
</style>
