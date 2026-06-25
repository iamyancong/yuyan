<script setup lang="ts">
import { computed } from 'vue';
import { YMonaco } from '@ycwang-dev/components/lite';
import { openExternal } from '@/utils/open';
import type { DeployRecord } from '@/api/deploy';
import { useRecordLog } from './hooks/useRecordLog';

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
const { logMonacoRef, recordLogContent, recordSummaries, handleDrawerAfterOpenChange } = useRecordLog(props);

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
    width="72%"
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
          :options="{ minimap: { enabled: false }, fontSize: 13, wordWrap: 'on', readOnly: true }"
        />
      </div>
    </a-spin>
  </a-drawer>
</template>

<style scoped lang="less">
@import './style.less';
</style>
