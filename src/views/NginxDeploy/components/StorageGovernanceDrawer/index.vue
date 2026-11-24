<script setup lang="ts">
import { ClearOutlined, DatabaseOutlined, ReloadOutlined } from '@ant-design/icons-vue';
import { YButton, YTable } from '@yss-ui/components/lite';
import OrphanAssetsPreviewModal from './components/OrphanAssetsPreviewModal.vue';
import StoragePruneConfirmModal from './components/StoragePruneConfirmModal.vue';
import StoragePruneProgressBanner from './components/StoragePruneProgressBanner.vue';
import StorageSummaryCards from './components/StorageSummaryCards.vue';
import { formatStorageBytes, INLINE_BACKUP_CLEAN_OPTIONS, storageAppColumns } from './constant';
import { useStorageGovernance } from './hooks/useStorageGovernance';
import type { StorageGovernanceDrawerEmits, StorageGovernanceDrawerProps } from './type';

defineOptions({ name: 'StorageGovernanceDrawer' });

const props = defineProps<StorageGovernanceDrawerProps>();
const emit = defineEmits<StorageGovernanceDrawerEmits>();

const gov = useStorageGovernance(props, emit);
</script>

<template>
  <a-drawer
    v-model:open="gov.visible.value"
    width="min(1080px, 94vw)"
    :title="`存储与备份治理 · ${instance?.name || ''}${serverName ? ` (${serverName})` : ''}`"
    class="storage-governance-drawer"
    :destroy-on-close="false"
  >
    <a-spin :spinning="gov.inspecting.value">
      <StorageSummaryCards v-if="gov.summary.value" :summary="gov.summary.value" />

      <div class="sg-action-panel">
        <div class="sg-action-panel__controls">
          <a-select
            v-model:value="gov.inlineAction.value"
            :options="[...INLINE_BACKUP_CLEAN_OPTIONS]"
            style="min-width: 310px"
            :disabled="gov.cleaning.value"
          />
          <a-checkbox v-model:checked="gov.applyRetentionPolicy.value" :disabled="gov.cleaning.value">
            按各目标保留策略裁剪（份数/空间/TTL）
          </a-checkbox>
          <a-checkbox v-model:checked="gov.runCasGc.value" :disabled="gov.cleaning.value">
            回收外置仓 CAS 孤儿对象
          </a-checkbox>
        </div>
        <a-space>
          <YButton :loading="gov.inspecting.value" :disabled="gov.cleaning.value" @click="gov.loadInspection">
            <template #icon><ReloadOutlined /></template>
            重新扫描
          </YButton>
          <YButton
            type="primary"
            :danger="gov.inlineAction.value === 'purge_all'"
            :loading="gov.cleaningAll.value"
            :disabled="gov.inspecting.value || gov.cleaning.value"
            @click="gov.openPruneConfirmModal"
          >
            <template #icon><ClearOutlined /></template>
            一键安全瘦身
          </YButton>
        </a-space>
      </div>

      <StoragePruneProgressBanner
        v-if="gov.pruneJob.value"
        :job="gov.pruneJob.value"
        @cancel="gov.cancelPruneBackups"
        @dismiss="gov.dismissPruneBanner"
      />

      <div v-if="gov.report.value?.stateRoot?.path" class="sg-path-bar">
        <span><DatabaseOutlined /> 外置状态仓：<code>{{ gov.report.value.stateRoot.path }}</code></span>
        <span v-if="gov.report.value.htmlRoot?.path">
          运行根目录：<code>{{ gov.report.value.htmlRoot.path }}</code>
          <span v-if="!gov.report.value.htmlRoot.exists" class="sg-muted">（未创建，已按实际应用目录汇总）</span>
        </span>
      </div>

      <div class="sg-table-wrap">
        <YTable
          :data="gov.apps.value"
          :columns="storageAppColumns"
          :action-config="gov.actionConfig.value"
          :loading="gov.inspecting.value"
          :pageable="false"
          :min-height="260"
          :max-height="460"
        >
          <template #displayName="{ row }">
            <div class="sg-app-cell">
              <span class="sg-app-cell__name">{{ row.displayName }}</span>
              <span class="sg-app-cell__path" :title="row.deployRoot">{{ row.deployRoot || row.slug }}</span>
            </div>
          </template>
          <template #managed="{ row }">
            <a-tag v-if="row.managed" color="processing">已纳管</a-tag>
            <a-tooltip v-else-if="row.otherTeamManaged" title="归属其他团队部署目标，已自动隔离禁止清理">
              <a-tag color="default">其他团队</a-tag>
            </a-tooltip>
            <a-tooltip v-else title="未纳管目录不参与一键全量瘦身，仅可逐个确认清理">
              <a-tag color="warning">未纳管目录</a-tag>
            </a-tooltip>
          </template>
          <template #inlineBackupBytes="{ row }">
            <span :class="{ 'sg-text-warn': row.inlineBackupBytes > 0 }">{{ formatStorageBytes(row.inlineBackupBytes) }}</span>
            <span v-if="row.inlineBackupCount > 0" class="sg-muted"> ({{ row.inlineBackupCount }}份)</span>
          </template>
          <template #externalBackupCount="{ row }">
            <span>{{ row.externalBackupCount }} 份</span>
            <span v-if="row.externalLogicalBytes > 0" class="sg-muted"> / {{ formatStorageBytes(row.externalLogicalBytes) }}</span>
          </template>
          <template #stagingBytes="{ row }">
            <span :class="{ 'sg-text-warn': row.stagingBytes > 0 }">{{ formatStorageBytes(row.stagingBytes) }}</span>
          </template>
        </YTable>
      </div>
    </a-spin>

    <StoragePruneConfirmModal
      v-model:open="gov.pruneConfirmOpen.value"
      :loading="gov.cleaningAll.value"
      :inline-action="gov.inlineAction.value"
      :apply-retention-policy="gov.applyRetentionPolicy.value"
      :run-cas-gc="gov.runCasGc.value"
      :impact="gov.pruneImpactSummary.value"
      @confirm="gov.confirmPruneAllBackups"
    />

    <OrphanAssetsPreviewModal
      v-model:open="gov.orphanModalOpen.value"
      :loading="gov.orphanLoading.value"
      :cleaning="gov.orphanCleaning.value"
      :min-age-days="gov.orphanMinAgeDays.value"
      :preview="gov.orphanPreview.value"
      @reload="gov.reloadOrphanPreview"
      @confirm="gov.confirmCleanOrphanAssets"
    />
  </a-drawer>
</template>

<style scoped lang="less">
@import './style.less';
</style>
