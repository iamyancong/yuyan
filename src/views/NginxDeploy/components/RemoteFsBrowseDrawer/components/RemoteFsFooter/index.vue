<script setup lang="ts">
import { computed } from 'vue';
import { CheckOutlined, CodeOutlined, FolderFilled, FolderOpenOutlined } from '@ant-design/icons-vue';
import { YButton } from '@yss-ui/components/lite';
import type { RemoteFsEntry } from '@/api/deploy';

defineOptions({ name: 'RemoteFsFooter' });

interface RemoteFsFooterProps {
  currentPath: string;
  selectedEntry: RemoteFsEntry | null;
  execPanelVisible: boolean;
  loading: boolean;
}

const props = defineProps<RemoteFsFooterProps>();
const emit = defineEmits<{
  (e: 'toggleExec'): void;
  (e: 'close'): void;
  (e: 'usePath'): void;
}>();

/** 计算最终将使用的目录与按钮文案 */
const targetChoice = computed(() => {
  if (props.selectedEntry && props.selectedEntry.type === 'directory') {
    return {
      isSubDir: true,
      name: props.selectedEntry.name,
      path: props.selectedEntry.path,
      label: `使用选中目录: ${props.selectedEntry.name}`,
    };
  }
  return {
    isSubDir: false,
    name: '当前目录',
    path: props.currentPath,
    label: '使用当前目录',
  };
});
</script>

<template>
  <div class="remote-fs-footer">
    <!-- 左侧：选中路径感知 -->
    <div class="footer-selection-badge">
      <span class="selection-prefix">当前选定:</span>
      <div class="badge-content" :title="targetChoice.path">
        <FolderFilled v-if="targetChoice.isSubDir" class="badge-icon is-sub" />
        <FolderOpenOutlined v-else class="badge-icon" />
        <span class="badge-name">{{ targetChoice.name }}</span>
        <code class="badge-path">({{ targetChoice.path || '加载中...' }})</code>
      </div>
    </div>

    <!-- 右侧：操作按钮组（运维终端 + 取消 + 核心确认） -->
    <div class="footer-actions-group">
      <YButton
        class="terminal-toggle-btn"
        :type="execPanelVisible ? 'primary' : 'default'"
        size="small"
        @click="emit('toggleExec')"
      >
        <template #icon><CodeOutlined /></template>
        {{ execPanelVisible ? '收起终端' : '运维终端' }}
      </YButton>

      <YButton size="small" @click="emit('close')">
        取消
      </YButton>

      <YButton
        type="primary"
        size="small"
        class="confirm-use-btn"
        :disabled="loading || !targetChoice.path"
        @click="emit('usePath')"
      >
        <template #icon><CheckOutlined /></template>
        {{ targetChoice.label }}
      </YButton>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
