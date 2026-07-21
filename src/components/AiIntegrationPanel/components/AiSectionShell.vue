<script setup lang="ts">
import { RightOutlined } from '@ant-design/icons-vue';

/** AI 控制中心分区壳层属性。 */
defineProps<{
  sectionId: string;
  title: string;
  summary: string;
  expanded: boolean;
}>();

const emit = defineEmits<{
  /** 切换当前分区展开状态。 */
  toggle: [];
}>();
</script>

<template>
  <section class="ai-section">
    <button
      class="ai-section__trigger"
      type="button"
      :aria-expanded="expanded"
      :aria-controls="sectionId"
      @click="emit('toggle')"
    >
      <span class="ai-section__title">
        <RightOutlined class="ai-section__arrow" />
        <span class="ai-section__icon"><slot name="icon" /></span>
        {{ title }}
      </span>
      <small>{{ summary }}</small>
    </button>
    <div v-show="expanded" :id="sectionId" class="ai-section__body">
      <slot />
    </div>
  </section>
</template>

<style scoped lang="less">
@import '../style.less';
</style>
