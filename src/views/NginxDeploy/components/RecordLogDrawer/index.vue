<script setup lang="ts">
import { computed } from 'vue';
import { YMonaco } from 'virtual:yss-heavy-components';
import { openExternal } from '@/utils/open';
import type { DeployRecord } from '@/api/deploy';
import { useRecordLog } from './hooks/useRecordLog';
import DeployLogLegend from '../DeployLogLegend/index.vue';
import SshFailureGuideCard from '../SshFailureGuideCard/index.vue';
import { extractSshFailureFromLogs } from '../../sshFailureGuide';

defineOptions({ name: 'RecordLogDrawer' });

/** 属性定义 */
const props = defineProps<{
  open: boolean;
  record: DeployRecord | null;
  loading?: boolean;
}>();

/** 事件定义 */
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

// 业务逻辑 hook
const {
  logMonacoRef,
  recordLogContent,
  recordSummaries,
  filterMode,
  errorSummary,
  totalLogsCount,
  errorLogsCount,
  jumpToErrorLine,
  handleDrawerAfterOpenChange,
} = useRecordLog(props);

/** 失败记录中的 SSH 失败引导（#47），只读展示 */
const sshFailure = computed(() => (props.record?.status === 'failed' ? extractSshFailureFromLogs(props.record?.logs || []) : null));

/** 抽屉打开状态 */
const drawerOpen = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
});
</script>

<template>
  <a-drawer
    v-model:open="drawerOpen"
    title="发布日志"
    width="75%"
    placement="right"
    destroyOnClose
    class="record-log-drawer"
    @after-open-change="handleDrawerAfterOpenChange"
  >
    <a-spin :spinning="Boolean(loading)">
      <div class="record-log-content">
        <div v-if="record" class="record-log-summary">
          <div v-for="item in recordSummaries" :key="item.label" class="record-log-summary__item">
            <span>{{ item.label }}</span>
            <strong v-if="item.link">
              <a :href="item.link" class="commit-link" @click.prevent.stop="openExternal(item.link)">{{ item.value }}</a>
            </strong>
            <strong v-else>{{ item.value }}</strong>
          </div>
        </div>

        <SshFailureGuideCard v-if="sshFailure" :failure="sshFailure" readonly class="record-log-ssh-guide" />

        <!-- 日志工具栏 -->
        <div class="record-log-toolbar">
          <div class="toolbar-left">
            <span class="toolbar-title">控制台日志</span>
            <a-radio-group v-model:value="filterMode" size="small" button-style="solid">
              <a-radio-button value="all">全部 ({{ totalLogsCount }})</a-radio-button>
              <a-radio-button value="errors">
                仅错误与告警
                <span v-if="errorLogsCount > 0">({{ errorLogsCount }})</span>
              </a-radio-button>
            </a-radio-group>
          </div>
          <div class="toolbar-right">
            <a-button
              v-if="record?.status === 'failed' && errorSummary"
              size="small"
              danger
              @click="jumpToErrorLine"
            >
              🚨 定位至错误诊断
            </a-button>
          </div>
        </div>

        <DeployLogLegend :show-context="filterMode === 'errors'" />

        <YMonaco
          ref="logMonacoRef"
          :model-value="recordLogContent"
          language="log"
          theme="vs-dark"
          height="calc(100vh - 320px)"
          :readonly="true"
          log-mode
          :max-lines="20000"
          :auto-scroll="true"
          :show-border="false"
          :options="{
            minimap: { enabled: false },
            fontSize: 13,
            wordWrap: 'on',
            readOnly: true,
            folding: false,
            guides: { indentation: false },
          }"
        />
      </div>
    </a-spin>
  </a-drawer>
</template>

<style scoped lang="less">
@import './style.less';
</style>
