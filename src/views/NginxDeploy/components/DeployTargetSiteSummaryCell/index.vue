<script setup lang="ts">
import { computed } from 'vue';
import { ExportOutlined } from '@ant-design/icons-vue';
import type { DeployTarget } from '@/api/deploy';
import { openExternal } from '@/utils/open';
import { getSiteReadinessStatus } from './constant';

defineOptions({ name: 'DeployTargetSiteSummaryCell' });

/**
 * 部署目标站点摘要属性
 */
interface DeployTargetSiteSummaryCellProps {
  /** 目标对象 */
  target?: DeployTarget | null;
}

const props = defineProps<DeployTargetSiteSummaryCellProps>();

const emit = defineEmits<{
  /** 触发去绑定实例动作 */
  (e: 'bindInstance', target: DeployTarget): void;
}>();

/** 计算站点摘要元信息 */
const meta = computed(() => getSiteReadinessStatus(props.target));

/** 点击访问地址 */
const handleOpenVisit = () => {
  if (meta.value.visitUrl) {
    openExternal(meta.value.visitUrl);
  }
};

/** 点击去绑定 */
const handleBindClick = () => {
  if (props.target) {
    emit('bindInstance', props.target);
  }
};
</script>

<template>
  <div class="deploy-target-site-summary">
    <!-- 主行：域名 → 目录:端口 路由映射 -->
    <a-tooltip :title="`${meta.domainText} → ${meta.destinationText}`">
      <div class="deploy-target-site-summary__route">
        <span :class="['route-domain', { 'is-fallback': meta.domainText === '未填域名' }]">
          {{ meta.domainText }}
        </span>
        <span class="route-arrow">→</span>
        <span class="route-dest">{{ meta.destinationText }}</span>
      </div>
    </a-tooltip>

    <!-- 副行：状态微标、去绑定动作、实例胶囊 -->
    <div class="deploy-target-site-summary__meta">
      <a-tag
        :color="meta.statusColor"
        :class="['status-badge', `status-${meta.status}`]"
        @click.stop="meta.isAccessible ? handleOpenVisit() : undefined"
      >
        {{ meta.statusLabel }}
        <ExportOutlined v-if="meta.isAccessible" />
      </a-tag>

      <!-- 未关联实例时展示便捷动作链接 -->
      <a
        v-if="meta.status === 'unlinked'"
        class="bind-action-btn"
        @click.stop.prevent="handleBindClick"
      >
        [去绑定]
      </a>

      <!-- 关联实例信息胶囊 -->
      <a-tooltip v-if="meta.instanceName" :title="`关联实例：${meta.instanceName} (${meta.instanceTypeLabel || '默认'})`">
        <span class="instance-pill">
          {{ meta.instanceTypeLabel ? `[${meta.instanceTypeLabel}] ` : '' }}{{ meta.instanceName }}
        </span>
      </a-tooltip>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
