<script setup lang="ts">
import { ClearOutlined, DatabaseOutlined, ReloadOutlined } from '@ant-design/icons-vue';
import { YButton, YTable } from '@yss-ui/components/lite';
import OrphanAssetsPreviewModal from './components/OrphanAssetsPreviewModal.vue';
import StorageSummaryCards from './components/StorageSummaryCards.vue';
import {
  formatStorageBytes,
  INLINE_BACKUP_CLEAN_OPTIONS,
  storageAppColumns,
} from './constant';
import { useStorageGovernance } from './hooks/useStorageGovernance';
import type { StorageGovernanceDrawerEmits, StorageGovernanceDrawerProps } from './type';

defineOptions({ name: 'StorageGovernanceDrawer' });

const props = defineProps<StorageGovernanceDrawerProps>();
const emit = defineEmits<StorageGovernanceDrawerEmits>();

const {
  actionConfig,
  applyRetentionPolicy,
  apps,
  cleaning,
  confirmCleanOrphanAssets,
  executePruneBackups,
  inlineAction,
  inspecting,
  loadInspection,
  orphanCleaning,
  orphanLoading,
  orphanMinAgeDays,
  orphanModalOpen,
  orphanPreview,
  reloadOrphanPreview,
  report,
  runCasGc,
  summary,
  visible,
} = useStorageGovernance(props, emit);
</script>

<template>
  <a-drawer
    v-model:open="visible"
    width="min(1080px, 94vw)"
    :title="`存储与备份治理 · ${instance?.name || ''}${serverName ? ` (${serverName})` : ''}`"
    class="storage-governance-drawer"
    :destroy-on-close="false"
  >
    <a-spin :spinning="inspecting">
      <StorageSummaryCards v-if="summary" :summary="summary" />

      <div class="sg-action-panel">
        <div class="sg-action-panel__controls">
          <a-select
            v-model:value="inlineAction"
            :options="[...INLINE_BACKUP_CLEAN_OPTIONS]"
            style="min-width: 310px"
            :disabled="cleaning"
          />
          <a-checkbox v-model:checked="applyRetentionPolicy" :disabled="cleaning">执行三维策略裁剪（份数/200MB/14天）</a-checkbox>
          <a-checkbox v-model:checked="runCasGc" :disabled="cleaning">回收外置仓 CAS 孤儿对象</a-checkbox>
        </div>
        <a-space>
          <YButton :loading="inspecting" :disabled="cleaning" @click="loadInspection">
            <template #icon><ReloadOutlined /></template>
            重新扫描
          </YButton>
          <a-popconfirm
            title="确认按所选策略执行存储清理？清理过程会持目录锁，不会中断正在发布的任务。"
            ok-text="立即清理"
            cancel-text="取消"
            @confirm="executePruneBackups()"
          >
            <YButton type="primary" :loading="cleaning" :disabled="inspecting">
              <template #icon><ClearOutlined /></template>
              一键安全瘦身
            </YButton>
          </a-popconfirm>
        </a-space>
      </div>

      <div v-if="report?.stateRoot?.path" class="sg-path-bar">
        <span><DatabaseOutlined /> 外置状态仓：<code>{{ report.stateRoot.path }}</code></span>
        <span v-if="report.htmlRoot?.path">运行根目录：<code>{{ report.htmlRoot.path }}</code></span>
      </div>

      <div class="sg-table-wrap">
        <YTable
          :data="apps"
          :columns="storageAppColumns"
          :action-config="actionConfig"
          :loading="inspecting"
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
            <a-tag v-else color="warning">未纳管目录</a-tag>
          </template>
          <template #inlineBackupBytes="{ row }">
            <span :class="{ 'sg-text-warn': row.inlineBackupBytes > 0 }">
              {{ formatStorageBytes(row.inlineBackupBytes) }}
            </span>
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

    <OrphanAssetsPreviewModal
      v-model:open="orphanModalOpen"
      :loading="orphanLoading"
      :cleaning="orphanCleaning"
      :min-age-days="orphanMinAgeDays"
      :preview="orphanPreview"
      @reload="reloadOrphanPreview"
      @confirm="confirmCleanOrphanAssets"
    />
  </a-drawer>
</template>

<style scoped lang="less">
@import './style.less';
</style>
