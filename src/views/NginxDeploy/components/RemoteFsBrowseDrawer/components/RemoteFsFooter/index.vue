<script setup lang="ts">
import { CodeOutlined } from '@ant-design/icons-vue';
import { YButton } from '@yss-ui/components/lite';
import type { RemoteFsEntry } from '@/api/deploy';

defineOptions({ name: 'RemoteFsFooter' });

interface RemoteFsFooterProps {
  selectedEntry: RemoteFsEntry | null;
  totalCount: number;
  execPanelVisible: boolean;
}

defineProps<RemoteFsFooterProps>();
const emit = defineEmits<{
  (e: 'toggleExec'): void;
  (e: 'close'): void;
}>();
</script>

<template>
  <div class="remote-fs-footer">
    <div class="footer-status">
      <span v-if="selectedEntry">已选中: {{ selectedEntry.name }}</span>
      <span v-else>共 {{ totalCount }} 项条目（单击选中，双击进入或返回）</span>
    </div>
    <div class="footer-actions">
      <YButton size="small" @click="emit('toggleExec')">
        <template #icon><CodeOutlined /></template>
        {{ execPanelVisible ? '收起命令面板' : '运行命令...' }}
      </YButton>
      <YButton size="small" @click="emit('close')">关闭</YButton>
    </div>
  </div>
</template>

<style scoped lang="less">
.remote-fs-footer {
  padding: 10px 16px;
  background: #ffffff;
  border-top: 1px solid #edf0f5;
  display: flex;
  align-items: center;
  justify-content: space-between;

  .footer-status {
    font-size: 12px;
    color: #8c8c8c;
  }

  .footer-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
}
</style>
