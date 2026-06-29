<script setup lang="ts">
import { computed } from 'vue';
import { YMonaco } from '@ycwang-dev/components/lite';
import type { DeployTarget } from '@/api/deploy';
import { useNginxConfig } from './hooks/useNginxConfig';

defineOptions({ name: 'NginxConfigDrawer' });

/** 属性定义 */
const props = defineProps<{
  targetId: number | null;
  target?: DeployTarget | null;
}>();

/** 事件定义 */
const emit = defineEmits<{
  (e: 'update:targetId', value: number | null): void;
  (e: 'save', targetId: number, content: string, done: (error?: unknown) => void): void;
}>();

// 业务逻辑 hook
const {
  loading,
  saving,
  configPath,
  content,
  isDirty,
  actionTip,
  handleSave,
} = useNginxConfig(props, emit);

/** 抽屉打开状态 */
const open = computed({
  get: () => Boolean(props.targetId),
  set: (value) => {
    if (!value) emit('update:targetId', null);
  },
});
</script>

<template>
  <a-drawer v-model:open="open" width="72%" placement="right" title="Nginx 配置文件管理" destroyOnClose>
    <a-spin :spinning="loading">
      <div class="nginx-config-path-bar">
        <span class="nginx-config-path-label">当前配置文件</span>
        <a-tag color="blue" class="nginx-config-path">{{ configPath || '未选择配置文件' }}</a-tag>
      </div>
      <div class="nginx-config-path-bar">
        <span class="nginx-config-path-label">Nginx 实例</span>
        <a-tag>{{ target?.serverName || '-' }}</a-tag>
        <a-tag color="purple">{{ target?.nginxInstanceName || '-' }}</a-tag>
        <a-tag>{{ target?.nginxInstanceType === 'managed' ? '托管' : '已有' }}</a-tag>
      </div>
      <YMonaco
        v-model:modelValue="content"
        language="nginx"
        theme="vs-dark"
        height="calc(100vh - 210px)"
        :format-on-mount="false"
        :options="{ minimap: { enabled: false }, fontSize: 13 }"
      />
    </a-spin>
    <template #footer>
      <div class="nginx-config-footer">
        <span :class="['nginx-config-action-tip', { 'is-ready': isDirty }]">{{ actionTip }}</span>
        <a-button type="primary" :disabled="!isDirty" :loading="saving" @click="handleSave">保存并重载</a-button>
      </div>
    </template>
  </a-drawer>
</template>

<style scoped lang="less">
@import './style.less';
</style>
