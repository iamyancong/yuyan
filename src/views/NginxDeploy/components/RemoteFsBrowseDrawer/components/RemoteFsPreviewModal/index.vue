<script setup lang="ts">
import { computed } from 'vue';
import { YMonaco } from 'virtual:yss-heavy-components';
import { detectFileLanguage, PREVIEW_MONACO_OPTIONS, type RemoteFsPreviewModalProps } from './constant';

defineOptions({ name: 'RemoteFsPreviewModal' });

const props = defineProps<RemoteFsPreviewModalProps>();
const emit = defineEmits<{ (e: 'update:open', val: boolean): void }>();

const visible = computed({
  get: () => props.open,
  set: (val: boolean) => emit('update:open', val),
});

/** 动态推导文件语法高亮语言 */
const language = computed(() => detectFileLanguage(props.fileName));
</script>

<template>
  <a-modal
    v-model:open="visible"
    :title="`文件预览 - ${fileName}`"
    width="min(960px, 92vw)"
    :footer="null"
    :destroy-on-close="true"
    :z-index="1300"
    wrap-class-name="remote-fs-preview-modal-wrap"
  >
    <a-spin :spinning="loading">
      <div class="remote-fs-preview-container">
        <YMonaco
          :model-value="content"
          :language="language"
          theme="vs-dark"
          height="520px"
          :readonly="true"
          :options="PREVIEW_MONACO_OPTIONS"
        />
      </div>
    </a-spin>
  </a-modal>
</template>

<style scoped lang="less">
@import './style.less';
</style>
