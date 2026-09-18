<script setup lang="ts">
import { computed } from 'vue';
import {
  FileTextOutlined,
  FolderOpenOutlined,
  InboxOutlined,
} from '@ant-design/icons-vue';
import type { NginxArchiveDownloadType } from '@/api/deploy';
import { getArchiveTypeOptions } from '../../constant';

defineOptions({ name: 'NginxArchiveTypeSelector' });

/** 归档类型选择器属性。 */
interface ArchiveTypeSelectorProps {
  modelValue: NginxArchiveDownloadType;
  disabled?: boolean;
  isManagedInstance?: boolean;
}

const props = withDefaults(defineProps<ArchiveTypeSelectorProps>(), {
  disabled: false,
  isManagedInstance: true,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: NginxArchiveDownloadType): void;
}>();

const options = computed(() => getArchiveTypeOptions(props.isManagedInstance));

/** 归档类型图标映射。 */
const ARCHIVE_TYPE_ICONS: Record<NginxArchiveDownloadType, any> = {
  all: InboxOutlined,
  html: FolderOpenOutlined,
  conf: FileTextOutlined,
};
</script>

<template>
  <div class="archive-type-selector" role="radiogroup" aria-label="交付内容类型">
    <div
      v-for="option in options"
      :key="option.value"
      role="radio"
      class="archive-type-card"
      :class="{
        'is-selected': modelValue === option.value,
        'is-disabled': disabled,
      }"
      :aria-checked="modelValue === option.value"
      tabindex="0"
      @click="!disabled && emit('update:modelValue', option.value)"
      @keydown.space.prevent="!disabled && emit('update:modelValue', option.value)"
      @keydown.enter.prevent="!disabled && emit('update:modelValue', option.value)"
    >
      <div class="archive-type-card__header">
        <div class="archive-type-card__title-wrap">
          <span class="archive-type-card__icon">
            <component :is="ARCHIVE_TYPE_ICONS[option.value]" />
          </span>
          <span class="archive-type-card__title">{{ option.label }}</span>
          <span v-if="option.badge === '推荐'" class="archive-type-card__badge">推荐</span>
        </div>
        <div class="archive-type-card__radio" aria-hidden="true">
          <span class="archive-type-card__radio-dot" />
        </div>
      </div>
      <div class="archive-type-card__description">{{ option.description }}</div>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
