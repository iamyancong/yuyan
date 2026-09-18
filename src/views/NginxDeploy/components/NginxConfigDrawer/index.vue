<script setup lang="ts">
import { computed } from 'vue';
import { YMonaco } from 'virtual:yss-heavy-components';
import type { DeployTarget } from '@/api/deploy';
import NginxConfigHeaderBar from './components/NginxConfigHeaderBar/index.vue';
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
  <a-drawer
    v-model:open="open"
    width="72%"
    placement="right"
    title="Nginx 配置文件管理"
    destroy-on-close
    root-class-name="nginx-config-drawer-root"
    :body-style="{ padding: '16px' }"
  >
    <a-spin :spinning="loading">
      <div class="nginx-config-drawer-body">
        <NginxConfigHeaderBar :target="target" :config-path="configPath" />
        <div class="nginx-config-editor-shell">
          <YMonaco
            v-model:modelValue="content"
            language="nginx"
            theme="vs-dark"
            height="calc(100vh - 200px)"
            :format-on-mount="false"
            :options="{ minimap: { enabled: false }, fontSize: 13 }"
          />
        </div>
      </div>
    </a-spin>
    <template #footer>
      <div class="nginx-config-footer">
        <span :class="['nginx-config-action-tip', { 'is-ready': isDirty }]">{{ actionTip }}</span>
        <a-space>
          <a-button @click="open = false">关闭</a-button>
          <a-button type="primary" :disabled="!isDirty" :loading="saving" @click="handleSave">保存并重载</a-button>
        </a-space>
      </div>
    </template>
  </a-drawer>
</template>

<style scoped lang="less">
@import './style.less';
</style>
