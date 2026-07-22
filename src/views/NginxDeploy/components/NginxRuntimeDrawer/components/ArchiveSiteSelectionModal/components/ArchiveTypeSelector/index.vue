<script setup lang="ts">
import {
  FileTextOutlined,
  FolderOpenOutlined,
  InboxOutlined,
} from '@ant-design/icons-vue';
import type { Component } from 'vue';
import type { NginxArchiveDownloadType } from '@/api/deploy';
import { ARCHIVE_TYPE_OPTIONS } from '../../constant';

defineOptions({ name: 'NginxArchiveTypeSelector' });

/** 归档类型选择器属性。 */
interface ArchiveTypeSelectorProps {
  modelValue: NginxArchiveDownloadType;
  disabled?: boolean;
}

defineProps<ArchiveTypeSelectorProps>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: NginxArchiveDownloadType): void;
}>();

/** 归档类型图标映射。 */
const ARCHIVE_TYPE_ICONS: Record<NginxArchiveDownloadType, Component> = {
  all: InboxOutlined,
  html: FolderOpenOutlined,
  conf: FileTextOutlined,
};
</script>

<template>
  <div class="archive-type-selector" role="radiogroup" aria-label="下载内容类型">
    <button
      v-for="option in ARCHIVE_TYPE_OPTIONS"
      :key="option.value"
      type="button"
      role="radio"
      class="archive-type-card"
      :class="{ 'is-selected': modelValue === option.value }"
      :aria-checked="modelValue === option.value"
      :disabled="disabled"
      @click="emit('update:modelValue', option.value)"
    >
      <span class="archive-type-card__index">{{ option.index }}</span>
      <span class="archive-type-card__icon"><component :is="ARCHIVE_TYPE_ICONS[option.value]" /></span>
      <span class="archive-type-card__copy">
        <span class="archive-type-card__title">
          <strong>{{ option.label }}</strong>
          <small>{{ option.badge }}</small>
        </span>
        <span class="archive-type-card__description">{{ option.description }}</span>
      </span>
    </button>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
