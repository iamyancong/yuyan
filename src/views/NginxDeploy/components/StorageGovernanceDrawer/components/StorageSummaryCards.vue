<script setup lang="ts">
import type { NginxStorageInspectionReport } from '@/api/deploy';
import { formatStorageBytes } from '../constant';

defineOptions({ name: 'StorageSummaryCards' });

/** 存储诊断总览卡片属性 */
interface StorageSummaryCardsProps {
  /** 诊断汇总指标 */
  summary: NginxStorageInspectionReport['summary'];
}

defineProps<StorageSummaryCardsProps>();
</script>

<template>
  <div class="sg-summary-grid">
    <div class="sg-metric-card">
      <div class="sg-metric-card__label">html/ 当前总占用（纯运行态）</div>
      <div class="sg-metric-card__value">{{ formatStorageBytes(summary.htmlTotalBytes) }}</div>
      <div class="sg-metric-card__sub">纯运行态约 {{ formatStorageBytes(summary.htmlRuntimeBytes) }}</div>
    </div>
    <div class="sg-metric-card sg-metric-card--warn">
      <div class="sg-metric-card__label">遗留内嵌 .yuyan-backups</div>
      <div class="sg-metric-card__value">{{ formatStorageBytes(summary.inlineBackupTotalBytes) }}</div>
      <div class="sg-metric-card__sub">共 {{ summary.inlineBackupTotalCount }} 份（打包迁移可直接省去）</div>
    </div>
    <div class="sg-metric-card sg-metric-card--accent">
      <div class="sg-metric-card__label">外置仓 .yuyan-state 对象池</div>
      <div class="sg-metric-card__value">{{ formatStorageBytes(summary.externalObjectsBytes) }}</div>
      <div class="sg-metric-card__sub">
        {{ summary.externalBackupTotalCount }} 份快照 · 逻辑 {{ formatStorageBytes(summary.externalLogicalTotalBytes) }}
        <template v-if="summary.dedupSavedPercent > 0">（去重省 {{ summary.dedupSavedPercent }}%）</template>
      </div>
    </div>
    <div class="sg-metric-card">
      <div class="sg-metric-card__label">孤儿备份（已无回滚入口）</div>
      <div class="sg-metric-card__value">{{ formatStorageBytes(summary.unreferencedBackupBytes) }}</div>
      <div class="sg-metric-card__sub">共 {{ summary.unreferencedBackupCount }} 份 · 暂存垃圾 {{ formatStorageBytes(summary.inlineStagingTotalBytes) }}</div>
    </div>
  </div>
</template>

<style scoped lang="less">
@import '../style.less';
</style>
