<script setup lang="ts">
import { computed } from 'vue';
import { DEPLOY_LOG_CONTEXT_LEGEND, DEPLOY_LOG_LEGEND } from '../../logPresentation';
import { useDeployLogHints } from '../../hooks/useDeployLogHints';

defineOptions({ name: 'DeployLogLegend' });

/** 属性定义 */
const props = defineProps<{
  /** 是否展示「失败上下文」图例（仅「仅错误与告警」模式） */
  showContext?: boolean;
}>();

/** 当前展示的图例项 */
const legendItems = computed(() => (props.showContext ? [...DEPLOY_LOG_LEGEND, DEPLOY_LOG_CONTEXT_LEGEND] : DEPLOY_LOG_LEGEND));

/** 白话提示开关（跨抽屉共享） */
const { showLogHints } = useDeployLogHints();
</script>

<template>
  <div class="deploy-log-legend">
    <div class="deploy-log-legend__items">
      <a-tooltip v-for="item in legendItems" :key="item.level" :title="item.description">
        <span :class="['deploy-log-legend__item', `is-${item.level}`]">
          <i v-if="item.level === 'tool'" class="deploy-log-legend__bar">│</i>
          <i v-else-if="item.level === 'context'" class="deploy-log-legend__bar">┆</i>
          <i v-else class="deploy-log-legend__dot" />
          {{ item.label }}
        </span>
      </a-tooltip>
    </div>
    <a-tooltip title="在费解的日志行尾追加 💡 一句话解释">
      <label class="deploy-log-legend__switch">
        <a-switch v-model:checked="showLogHints" size="small" />
        白话提示
      </label>
    </a-tooltip>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
