<script setup lang="ts">
import { computed } from 'vue';
import { YButton, YMonaco } from '@yss-ui/components/lite';
import type { DeployTarget } from '@/api/deploy';

defineOptions({ name: 'BackendServiceLogDrawer' });

/** 后端服务日志抽屉属性 */
interface BackendServiceLogDrawerProps {
  open: boolean;
  target: DeployTarget | null;
  content: string;
  loading: boolean;
}

const props = defineProps<BackendServiceLogDrawerProps>();
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'refresh'): void;
}>();

/** 抽屉双向绑定状态 */
const drawerOpen = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
});
</script>

<template>
  <a-drawer v-model:open="drawerOpen" width="min(86vw, 1000px)" placement="right" destroyOnClose title="后端服务日志">
    <div class="service-log-summary">
      <span>{{ target?.projectName || '-' }}</span>
      <a-tag>{{ target?.serviceName || '-' }}</a-tag>
      <a-tag color="blue">{{ target?.serverName || '-' }}</a-tag>
      <a-tag color="purple">端口 {{ target?.serverPort || '-' }}</a-tag>
    </div>
    <a-spin :spinning="loading">
      <YMonaco
        :model-value="content"
        language="log"
        theme="vs-dark"
        height="calc(100vh - 180px)"
        :readonly="true"
        log-mode
        :max-lines="5000"
        :auto-scroll="true"
        :options="{ minimap: { enabled: false }, fontSize: 13, wordWrap: 'on', readOnly: true }"
      />
    </a-spin>
    <template #footer>
      <div class="service-log-footer">
        <span>读取服务器 shared/logs/app.log 最近 1000 行</span>
        <YButton :loading="loading" @click="emit('refresh')">刷新日志</YButton>
      </div>
    </template>
  </a-drawer>
</template>

<style scoped lang="less">
@import './style.less';
</style>
