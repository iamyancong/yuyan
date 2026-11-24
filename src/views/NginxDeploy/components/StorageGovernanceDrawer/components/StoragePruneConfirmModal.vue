<script setup lang="ts">
import { computed } from 'vue';
import { YButton } from '@yss-ui/components/lite';
import type { PruneNginxStorageBackupsPayload } from '@/api/deploy';
import { formatStorageBytes } from '../constant';

defineOptions({ name: 'StoragePruneConfirmModal' });

/** 清理影响预览摘要 */
export interface StoragePruneImpactSummary {
  managedAppCount: number;
  skippedUnmanagedCount: number;
  skippedOtherTeamCount: number;
  estimatedInlineDeleteCount: number;
  estimatedInlineFreeBytes: number;
  estimatedRetentionDeleteCount: number;
  estimatedInvalidatedRollbackCount: number;
  migratedAppsClearingInline: number;
}

interface StoragePruneConfirmModalProps {
  open: boolean;
  loading: boolean;
  inlineAction: NonNullable<PruneNginxStorageBackupsPayload['inlineAction']>;
  applyRetentionPolicy: boolean;
  runCasGc: boolean;
  impact: StoragePruneImpactSummary;
}

const props = defineProps<StoragePruneConfirmModalProps>();
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'confirm'): void;
}>();

const isHighRisk = computed(
  () => props.inlineAction === 'purge_all' || props.impact.estimatedInvalidatedRollbackCount > 0
);

const actionLabelMap: Record<NonNullable<PruneNginxStorageBackupsPayload['inlineAction']>, string> = {
  keep_latest_1: '保留最新 1 份（已迁移外置仓则全清旧内嵌）',
  purge_unreferenced: '仅清理脱离发布记录的孤儿内嵌备份',
  purge_all: '清空全部旧内嵌 .yuyan-backups',
  none: '暂不处理内嵌备份',
};
</script>

<template>
  <a-modal
    :open="open"
    width="min(560px, 92vw)"
    title="确认执行存储清理（删除不可恢复）"
    :mask-closable="!loading"
    :closable="!loading"
    @cancel="emit('update:open', false)"
  >
    <a-alert
      :type="isHighRisk ? 'warning' : 'info'"
      show-icon
      class="sg-confirm-alert"
      :message="
        isHighRisk
          ? '本次清理将永久删除远程旧备份文件，删除不可恢复，请确认影响范围后再继续。'
          : '清理过程将与发布/回滚共用同一目录锁，不会中断正在执行的发布任务；已删除文件不可恢复。'
      "
    />

    <ul class="sg-confirm-list">
      <li>
        <strong>作用范围：</strong>仅处理当前团队已纳管的
        <strong>{{ impact.managedAppCount }}</strong> 个应用
        <span v-if="impact.skippedUnmanagedCount > 0 || impact.skippedOtherTeamCount > 0" class="sg-muted">
          （已自动保护并跳过
          <template v-if="impact.skippedOtherTeamCount > 0">{{ impact.skippedOtherTeamCount }} 个其他团队目录</template>
          <template v-if="impact.skippedOtherTeamCount > 0 && impact.skippedUnmanagedCount > 0">、</template>
          <template v-if="impact.skippedUnmanagedCount > 0">{{ impact.skippedUnmanagedCount }} 个未纳管目录</template>
          ）
        </span>
      </li>
      <li>
        <strong>内嵌备份策略：</strong>{{ actionLabelMap[inlineAction] }}
        <span v-if="impact.estimatedInlineDeleteCount > 0">
          （预计删除 <strong>{{ impact.estimatedInlineDeleteCount }}</strong> 份，释放约
          <strong>{{ formatStorageBytes(impact.estimatedInlineFreeBytes) }}</strong>）
        </span>
      </li>
      <li v-if="applyRetentionPolicy">
        <strong>三维策略裁剪：</strong>按各目标自身配置的保留策略执行（至少保底留最新 1 份）
        <span v-if="impact.estimatedRetentionDeleteCount > 0">
          （预计额外裁剪约 <strong>{{ impact.estimatedRetentionDeleteCount }}</strong> 份超份数/超期快照）
        </span>
      </li>
      <li v-if="runCasGc">
        <strong>CAS 对象池回收：</strong>在无活跃备份/回滚租约时安全回收孤儿对象
      </li>
    </ul>

    <a-alert
      v-if="impact.estimatedInvalidatedRollbackCount > 0 || impact.migratedAppsClearingInline > 0"
      type="error"
      show-icon
      class="sg-confirm-alert"
      :message="
        impact.migratedAppsClearingInline > 0 && inlineAction === 'keep_latest_1'
          ? `注意：有 ${impact.migratedAppsClearingInline} 个已迁移至外置仓的应用将清空历史内嵌备份，迁移前的旧回滚点将一并失效（预计影响约 ${impact.estimatedInvalidatedRollbackCount} 条历史回滚记录，删除不可恢复）。`
          : `注意：本次操作预计将使约 ${impact.estimatedInvalidatedRollbackCount} 条历史回滚记录同步失效，删除不可恢复。`
      "
    />

    <template #footer>
      <a-space>
        <YButton :disabled="loading" @click="emit('update:open', false)">取消</YButton>
        <YButton
          type="primary"
          :danger="isHighRisk"
          :loading="loading"
          @click="emit('confirm')"
        >
          {{ isHighRisk ? '确认清理（不可恢复）' : '立即清理' }}
        </YButton>
      </a-space>
    </template>
  </a-modal>
</template>

<style scoped lang="less">
@import '../style.less';
</style>
