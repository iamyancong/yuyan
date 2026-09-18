<script setup lang="ts">
import { computed } from 'vue';

defineOptions({ name: 'RemoteFsPreviewModal' });

interface RemoteFsPreviewModalProps {
  open: boolean;
  loading: boolean;
  fileName: string;
  content: string;
}

const props = defineProps<RemoteFsPreviewModalProps>();
const emit = defineEmits<{ (e: 'update:open', val: boolean): void }>();

const visible = computed({
  get: () => props.open,
  set: (val: boolean) => emit('update:open', val),
});
</script>

<template>
  <a-modal
    v-model:open="visible"
    :title="`文件预览 - ${fileName}`"
    width="min(900px, 90vw)"
    :footer="null"
    :destroy-on-close="true"
    :z-index="1300"
    wrap-class-name="remote-fs-preview-modal-wrap"
  >
    <a-spin :spinning="loading">
      <pre class="remote-fs-preview-pre">{{ content || '(文件为空)' }}</pre>
    </a-spin>
  </a-modal>
</template>

<style scoped lang="less">
:global(.remote-fs-preview-modal-wrap) {
  z-index: 1300 !important;
}

.remote-fs-preview-pre {
  max-height: 520px;
  overflow: auto;
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 14px;
  border-radius: 6px;
  font-family: monospace;
  font-size: 13px;
  line-height: 1.5;
  margin: 0;
}
</style>
