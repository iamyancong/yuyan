<script setup lang="ts">
import { computed, nextTick, shallowRef, watch } from 'vue';
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

/** 只读编辑器实例（用于定位行） */
const editorRef = shallowRef<any>(null);
const bindEditor = (instance: any) => {
  editorRef.value = instance && typeof instance.getInstance === 'function' ? instance.getInstance() : instance || null;
};

/** 内容加载完成后定位到指定行并选中整行 */
const revealTargetLine = async () => {
  const line = Number(props.revealLine || 0);
  if (!props.open || props.loading || !line || !props.content) return;
  await nextTick();
  // Monaco 首次挂载后模型赋值是异步的，稍等再定位
  setTimeout(() => {
    const editor = editorRef.value;
    const model = editor?.getModel?.();
    if (!editor || !model) return;
    const safeLine = Math.min(Math.max(1, line), model.getLineCount?.() || line);
    editor.revealLineInCenter?.(safeLine);
    editor.setSelection?.({
      startLineNumber: safeLine,
      startColumn: 1,
      endLineNumber: safeLine,
      endColumn: model.getLineMaxColumn?.(safeLine) || 1,
    });
  }, 120);
};
watch(() => [props.open, props.loading, props.content, props.revealLine, editorRef.value], revealTargetLine);
</script>

<template>
  <a-modal
    v-model:open="visible"
    :title="titleSuffix ? `文件预览 - ${fileName}（${titleSuffix}）` : `文件预览 - ${fileName}`"
    width="min(960px, 92vw)"
    :footer="null"
    :destroy-on-close="true"
    :z-index="1300"
    wrap-class-name="remote-fs-preview-modal-wrap"
  >
    <a-spin :spinning="loading">
      <div class="remote-fs-preview-container">
        <YMonaco
          :ref="bindEditor"
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
