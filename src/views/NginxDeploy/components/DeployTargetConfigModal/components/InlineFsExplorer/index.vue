<script setup lang="ts">
import {
  ArrowUpOutlined,
  CheckCircleOutlined,
  CloseOutlined,
  FolderFilled,
  LockFilled,
  LockOutlined,
  RightOutlined,
  ReloadOutlined,
} from '@ant-design/icons-vue';
import { YButton, YTable } from '@yss-ui/components/lite';
import type { RemoteFsEntry } from '@/api/deploy';
import { inlineFsColumns, type InlineFsExplorerProps } from './constant.ts';
import { useInlineFsExplorer } from './hooks/useInlineFsExplorer.ts';

defineOptions({ name: 'InlineFsExplorer' });

const props = defineProps<InlineFsExplorerProps>();
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void; (e: 'close'): void }>();

const {
  loading, showHidden, currentPath, selectedPath, selectedOccupant,
  isAtRoot, breadcrumbs, tableEntries, fetchDirectory, navigateUp,
  drillDown, handleRowClick, handleRowDblClick, isRowSelected,
} = useInlineFsExplorer(props, emit);
</script>

<template>
  <div class="inline-fs-card">
    <div class="inline-fs-toolbar">
      <div class="toolbar-left">
        <div class="scope-badge" :title="`当前目录已锁定在 [${scopeLabel || '站点根'}] (${lockedRoot})`">
          <LockFilled class="badge-icon" />
          <span class="badge-text">{{ scopeLabel || '站点根' }}</span>
        </div>
        <div class="breadcrumbs-box">
          <template v-for="seg in breadcrumbs" :key="seg.path">
            <span class="crumb-sep">/</span>
            <span
              class="crumb-item"
              :class="{ 'is-active': seg.isLast, 'is-disabled': seg.disabled }"
              :title="seg.disabled ? seg.disabledReason : `跳转到 ${seg.path}`"
              @click="!seg.disabled && !seg.isLast && fetchDirectory(seg.path)"
            >
              {{ seg.name }}
            </span>
          </template>
        </div>
      </div>
      <div class="toolbar-right">
        <YButton size="small" :disabled="isAtRoot || loading" title="返回上一级" @click="navigateUp"><ArrowUpOutlined /></YButton>
        <YButton size="small" :loading="loading" title="刷新" @click="() => fetchDirectory(currentPath)"><ReloadOutlined /></YButton>
        <YButton size="small" title="收起目录面板" @click="emit('close')"><CloseOutlined /></YButton>
      </div>
    </div>

    <div class="inline-fs-table-wrap">
      <YTable
        :data="tableEntries"
        :columns="inlineFsColumns"
        :loading="loading"
        :pageable="false"
        size="small"
        :max-height="220"
        :row-config="{ keyField: 'name', isCurrent: true }"
        @cell-click="({ row }: any) => handleRowClick(row as RemoteFsEntry)"
        @cell-dblclick="({ row }: any) => handleRowDblClick(row as RemoteFsEntry)"
      >
        <template #name="{ row }">
          <div class="inline-entry-row" :class="{ 'is-selected': isRowSelected(row), 'is-parent-row': row.type === 'parent_dir' }">
            <span class="entry-icon-box" @click.stop="row.type === 'parent_dir' ? navigateUp() : drillDown(row.name)">
              <ArrowUpOutlined v-if="row.type === 'parent_dir'" class="entry-icon is-parent" />
              <FolderFilled v-else class="entry-icon is-dir" />
            </span>
            <span class="entry-name-link" :class="{ 'is-parent': row.type === 'parent_dir' }" :title="row.name" @click.stop="row.type === 'parent_dir' ? navigateUp() : drillDown(row.name)">
              {{ row.name }}
            </span>
          </div>
        </template>
        <template #status="{ row }">
          <div v-if="row.type === 'directory'" class="inline-status-cell">
            <a-tag v-if="row.occupiedBy" color="warning" class="status-occupied-tag" :title="row.occupiedBy"><LockOutlined /> {{ row.occupiedBy }}</a-tag>
            <a-tag v-else color="success" class="status-available-tag"><CheckCircleOutlined /> 可选</a-tag>
          </div>
          <span v-else class="status-empty">-</span>
        </template>
        <template #action="{ row }">
          <div class="entry-actions">
            <YButton v-if="row.type === 'directory'" type="link" size="small" class="action-btn" title="进入此目录" @click.stop="drillDown(row.name)">进入 <RightOutlined class="action-icon" /></YButton>
            <YButton v-else-if="row.type === 'parent_dir'" type="link" size="small" class="action-btn is-parent-btn" title="返回上一级" @click.stop="navigateUp">返回</YButton>
          </div>
        </template>
      </YTable>
    </div>

    <div class="inline-fs-footer">
      <div class="footer-left">
        <a-checkbox v-model:checked="showHidden" class="show-hidden-checkbox">隐藏项</a-checkbox>
        <div class="footer-tip-bar" :class="{ 'is-conflict': Boolean(selectedOccupant) }">
          <span v-if="selectedOccupant" class="tip-text is-warning" :title="`已被 ${selectedOccupant} 占用`">
            ⚠️ 已被 {{ selectedOccupant }} 占用 (不可选)
          </span>
          <span v-else class="tip-text is-normal" :title="selectedPath || modelValue">
            选定: {{ selectedPath || modelValue || '(请点击目录)' }}
          </span>
        </div>
      </div>
      <YButton type="primary" size="small" @click="emit('close')">应用并收起</YButton>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
