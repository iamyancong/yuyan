<script setup lang="ts">
import { computed } from 'vue';
import { ArrowUpOutlined, CheckCircleOutlined, ExclamationCircleFilled, FolderFilled, FolderOpenFilled, LockFilled, LockOutlined, RightOutlined, ReloadOutlined } from '@ant-design/icons-vue';
import { YButton, YTable } from '@yss-ui/components/lite';
import type { RemoteFsEntry } from '@/api/deploy';
import { fsSelectTableColumns, type RemoteFsSelectModalProps } from './constant';
import { useRemoteFsSelect } from './hooks/useRemoteFsSelect';

defineOptions({ name: 'RemoteFsSelectModal' });

const props = defineProps<RemoteFsSelectModalProps>();
const emit = defineEmits<{ (e: 'update:open', value: boolean): void; (e: 'select', path: string): void }>();
const visible = computed({ get: () => props.open, set: (val: boolean) => emit('update:open', val) });

const {
  loading, showHidden, roots, activeRoot, currentPath, selectedPath,
  selectedOccupant, isAtRoot, breadcrumbs, tableEntries, fetchDirectory,
  navigateUp, drillDown, switchRoot, handleRowClick, handleRowDblClick,
  confirmSelection, isRowSelected,
} = useRemoteFsSelect(props, emit);

const getPopupContainer = (triggerNode: HTMLElement) =>
  triggerNode?.closest<HTMLElement>('.ant-modal-content') || triggerNode?.parentElement || triggerNode;
</script>

<template>
  <a-modal
    v-model:open="visible"
    width="min(820px, 94vw)"
    centered
    :destroy-on-close="true"
    :z-index="1200"
    wrap-class-name="remote-fs-select-modal-wrap"
    @cancel="emit('update:open', false)"
  >
    <template #title>
      <div class="select-header-title">
        <span class="title-main">选择服务器部署根目录</span>
        <span v-if="server" class="server-badge">{{ server.name }} ({{ server.host }})</span>
      </div>
    </template>

    <div class="remote-fs-select-shell">
      <div class="select-toolbar">
        <YButton size="small" :disabled="isAtRoot || loading" title="返回上一级目录" @click="navigateUp"><ArrowUpOutlined /> 上级</YButton>
        <div v-if="lockedRoot" class="scope-lock-badge" :title="`当前作用域已锁定在 [${scopeLabel || activeRoot?.label || '当前站点根'}] (${lockedRoot})`">
          <LockFilled class="badge-icon" />
          <span class="badge-text">{{ scopeLabel || activeRoot?.label || '站点根' }}</span>
        </div>
        <a-select
          v-else
          :value="activeRoot?.id"
          size="small"
          class="root-select"
          popup-class-name="root-select-dropdown"
          dropdown-class-name="root-select-dropdown"
          :dropdown-style="{ zIndex: 1300 }"
          :get-popup-container="getPopupContainer"
          placeholder="切换受限作用域"
          @change="(val: any) => { const found = roots.find((r) => r.id === val); if (found) switchRoot(found); }"
        >
          <a-select-option v-for="item in roots" :key="item.id" :value="item.id">{{ item.label }}</a-select-option>
        </a-select>
        <div class="breadcrumbs-wrap">
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
        <YButton size="small" :loading="loading" title="刷新目录" @click="() => fetchDirectory(currentPath)"><ReloadOutlined /></YButton>
      </div>

      <div class="select-table-wrap">
        <YTable
          :data="tableEntries"
          :columns="fsSelectTableColumns"
          :loading="loading"
          :pageable="false"
          size="small"
          :max-height="360"
          :row-config="{ keyField: 'name', isCurrent: true }"
          @cell-click="({ row }: any) => handleRowClick(row as RemoteFsEntry)"
          @cell-dblclick="({ row }: any) => handleRowDblClick(row as RemoteFsEntry)"
        >
          <template #name="{ row }">
            <div class="select-entry-row" :class="{ 'is-selected': isRowSelected(row), 'is-parent-row': row.type === 'parent_dir' }">
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
            <div v-if="row.type === 'directory'" class="select-status-cell">
              <a-tag v-if="row.occupiedBy" color="warning" class="status-occupied-tag" :title="row.occupiedBy"><LockOutlined /> {{ row.occupiedBy }}</a-tag>
              <a-tag v-else color="success" class="status-available-tag"><CheckCircleOutlined /> 空闲可用</a-tag>
            </div>
            <span v-else class="status-empty">-</span>
          </template>
          <template #action="{ row }">
            <div class="entry-actions">
              <YButton v-if="row.type === 'directory'" type="link" size="small" class="action-drill-btn" title="进入此目录" @click.stop="drillDown(row.name)">进入 <RightOutlined class="action-icon" /></YButton>
              <YButton v-else-if="row.type === 'parent_dir'" type="link" size="small" class="action-drill-btn is-parent-btn" title="返回上一级" @click.stop="navigateUp">返回</YButton>
            </div>
          </template>
        </YTable>
      </div>
    </div>

    <template #footer>
      <div class="select-modal-footer">
        <div class="footer-left">
          <a-checkbox v-model:checked="showHidden" class="show-hidden-checkbox">显示隐藏项</a-checkbox>
          <div class="footer-selection-bar" :class="{ 'is-conflict': Boolean(selectedOccupant) }">
            <span class="selection-label">选定:</span>
            <span v-if="selectedOccupant" class="selection-content is-warning" :title="`已被 ${selectedOccupant} 占用`">
              <ExclamationCircleFilled /> 已被 {{ selectedOccupant }} 占用 (不可选)
            </span>
            <span v-else class="selection-content is-normal" :title="selectedPath || currentPath">
              <FolderOpenFilled /> {{ selectedPath || currentPath || '(未选择)' }}
            </span>
          </div>
        </div>
        <div class="footer-actions">
          <YButton @click="emit('update:open', false)">取消</YButton>
          <YButton type="primary" :disabled="!selectedPath && !currentPath || Boolean(selectedOccupant)" @click="confirmSelection">确定使用此路径</YButton>
        </div>
      </div>
    </template>
  </a-modal>
</template>

<style scoped lang="less">
@import './style.less';
</style>
