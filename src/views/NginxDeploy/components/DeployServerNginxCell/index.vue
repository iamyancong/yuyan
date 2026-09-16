<script setup lang="ts">
import { computed } from 'vue';
import { PlusCircleOutlined } from '@ant-design/icons-vue';
import type { DeployServer } from '@/api/deploy';
import { calcServerNginxSummary } from './constant';

defineOptions({ name: 'DeployServerNginxCell' });

/**
 * 服务器 Nginx 单元格属性
 */
interface DeployServerNginxCellProps {
  /** 部署服务器对象 */
  server?: DeployServer | null;
}

const props = defineProps<DeployServerNginxCellProps>();

const emit = defineEmits<{
  /** 点击单元格触发打开 Nginx 抽屉并定位到当前服务器 */
  (e: 'click', server: DeployServer): void;
}>();

/** Nginx 实例与健康状态快照 */
const summary = computed(() => calcServerNginxSummary(props.server));

/** 点击单元格处理 */
const handleClick = () => {
  if (props.server) {
    emit('click', props.server);
  }
};
</script>

<template>
  <a-tooltip :title="summary.tooltipText">
    <div class="deploy-server-nginx-cell" @click.stop="handleClick">
      <template v-if="!summary.hasInstance">
        <span class="deploy-server-nginx-cell__empty">
          <PlusCircleOutlined /> 无实例
        </span>
      </template>

      <template v-else>
        <div class="deploy-server-nginx-cell__tags">
          <span v-if="summary.managedCount > 0" class="instance-tag managed">
            {{ summary.managedCount > 1 ? `${summary.managedCount} 托管` : '托管' }}
          </span>
          <span v-if="summary.externalCount > 0" class="instance-tag external">
            {{ summary.externalCount > 1 ? `${summary.externalCount} 已有` : '已有' }}
          </span>
        </div>

        <div class="nginx-health-badge">
          <span :class="['status-dot', `status-${summary.health}`]" />
          <span class="status-text">{{ summary.healthLabel }}</span>
        </div>
      </template>
    </div>
  </a-tooltip>
</template>

<style scoped lang="less">
@import './style.less';
</style>
