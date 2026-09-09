<script setup lang="ts">
import { computed } from 'vue';
import { YMonaco, YMonacoDiff } from '@yss-ui/components/lite';
import type { FileItem, OperationMode } from '../constant';

defineOptions({ name: 'FilePreviewCard' });

/** 属性定义 */
const props = defineProps<{
  /** 文件列表 */
  files: FileItem[];
  /** 当前激活的文件索引 */
  activeIndex: number;
  /** 操作模式 */
  mode: OperationMode;
}>();

/** 事件定义 */
const emit = defineEmits<{
  'update:activeIndex': [value: number];
  'update:editedContent': [value: string];
}>();

/** 当前激活文件 */
const currentFile = computed(() => props.files[props.activeIndex]);

/** 文件类型标签 */
const fileTypeTag = computed(() => {
  if (!currentFile.value) return null;

  // 如果存在 existingContent 且不为空字符串，说明是修改文件
  const isModify = currentFile.value.existingContent !== undefined && currentFile.value.existingContent !== '';

  return {
    text: isModify ? '修改' : '新增',
    color: isModify ? 'processing' : 'success',
  };
});

/** 绑定激活索引 */
const vActiveIndex = computed({
  get: () => props.activeIndex,
  set: (v) => emit('update:activeIndex', v),
});

/** 绑定编辑内容 */
const vEditedContent = computed({
  get: () => currentFile.value?.editedContent || '',
  set: (v) => emit('update:editedContent', v),
});
</script>

<template>
  <div v-if="files.length">
    <a-form layout="vertical" class="compact-form">
      <a-form-item>
        <template #label>
          <span>配置文件路径</span>
          <a-tag v-if="fileTypeTag" :color="fileTypeTag.color" style="margin-left: 8px">
            {{ fileTypeTag.text }}
          </a-tag>
        </template>

        <!-- 多文件选择器 -->
        <a-select
          v-if="files.length > 1"
          v-model:value="vActiveIndex"
          :options="files.map((f, i) => ({ label: f.targetPath, value: i }))"
          size="small"
        />

        <!-- 单文件展示 -->
        <a-input
          v-else
          :value="files[0].targetPath"
          readonly
          size="small"
          style="color: var(--primary-color); background-color: var(--primary-color-lighter); border-color: var(--primary-color-light)"
        />
      </a-form-item>
    </a-form>

    <!-- Diff 模式（更新）-->
    <template v-if="mode === 'update'">
      <YMonacoDiff height="60vh" language="yaml" theme="vs-dark" :original="currentFile.existingContent || ''" v-model:value="vEditedContent" />
    </template>

    <!-- 编辑器模式（新建）-->
    <template v-else>
      <YMonaco height="60vh" language="yaml" theme="vs-dark" v-model:modelValue="vEditedContent" />
    </template>
  </div>
</template>
<style scoped lang="less">
@import '../style.less';
</style>
