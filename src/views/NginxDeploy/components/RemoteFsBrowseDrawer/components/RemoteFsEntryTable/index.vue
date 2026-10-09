<script setup lang="ts">
import { ref } from 'vue';
import {
  ArrowUpOutlined,
  FolderFilled,
  SortAscendingOutlined,
  SortDescendingOutlined,
} from '@ant-design/icons-vue';
import { YButton, YTable } from '@yss-ui/components/lite';
import { useTableHeight } from '@yss-ui/hooks';
import type { RemoteFsEntry } from '@/api/deploy';
import { fsTableColumns, getFileVisualBadge } from '../../constant';
import type { FsSortField } from '../../hooks/useRemoteFsBrowse';
import { useTableInteraction } from './hooks/useTableInteraction';

defineOptions({ name: 'RemoteFsEntryTable' });

interface RemoteFsEntryTableProps {
  entries: RemoteFsEntry[];
  loading: boolean;
  truncated: boolean;
  dirCount: number;
  fileCount: number;
  sortField: FsSortField;
  sortAsc: boolean;
  selectedCount?: number;
  selectedPathSet?: Set<string>;
}

const props = defineProps<RemoteFsEntryTableProps>();
const emit = defineEmits<{
  (e: 'rowClick', entry: RemoteFsEntry, event?: MouseEvent): void;
  (e: 'rowDblclick', entry: RemoteFsEntry): void;
  (e: 'rowContextMenu', entry: RemoteFsEntry, event: MouseEvent): void;
  (e: 'navigateUp'): void;
  (e: 'drillDown', name: string): void;
  (e: 'preview', entry: RemoteFsEntry): void;
  (e: 'toggleSort', field: FsSortField): void;
  (e: 'selectAll'): void;
  (e: 'clearSelection'): void;
}>();

const tableAreaRef = ref<HTMLElement>();
const { tableHeight, isReady } = useTableHeight(tableAreaRef, {
  minHeight: 240,
  defaultHeight: 460,
});

/** 判定当前行是否命中多选高亮。 */
const getRowClassName = ({ row }: { row: RemoteFsEntry }) =>
  props.selectedPathSet?.has(row.path || '') ? 'is-row-selected row--current' : '';

/** 抽离后的键盘快捷键、Shift 选区拦截与右键菜单交互 */
const { handleKeyDown, handleMouseDown, handleAreaClick, handleAreaContextMenu } =
  useTableInteraction({
    tableAreaRef,
    getEntries: () => props.entries,
    getSelectedCount: () => props.selectedCount || 0,
    onSelectAll: () => emit('selectAll'),
    onClearSelection: () => emit('clearSelection'),
    onRowContextMenu: (entry, event) => emit('rowContextMenu', entry, event),
  });
</script>

<template>
  <div class="remote-fs-table-wrap">
    <!-- 表格区域 -->
    <div
      ref="tableAreaRef"
      class="remote-fs-table-area"
      tabindex="0"
      @keydown="handleKeyDown"
      @mousedown="handleMouseDown"
      @click="handleAreaClick"
      @contextmenu.prevent="handleAreaContextMenu"
    >
      <YTable
        v-if="isReady"
        :data="entries"
        :columns="fsTableColumns"
        :loading="loading"
        :pageable="false"
        :height="tableHeight"
        :border="false"
        :row-class-name="getRowClassName"
        :row-config="{ keyField: 'name', isCurrent: false, isHover: true }"
        @cell-click="({ row, $event }: any) => emit('rowClick', row as RemoteFsEntry, $event)"
        @cell-dblclick="({ row }: any) => emit('rowDblclick', row as RemoteFsEntry)"
      >
        <!-- 表头：名称（包含排序与统计胶囊） -->
        <template #name-header>
          <div class="interactive-th is-left" @click="emit('toggleSort', 'name')">
            <span class="th-title-label" :class="{ 'is-sorted': sortField === 'name' }">名称</span>
            <span class="th-sort-icon" :class="{ 'is-active': sortField === 'name' }">
              <SortAscendingOutlined v-if="sortField === 'name' && sortAsc" />
              <SortDescendingOutlined v-else-if="sortField === 'name' && !sortAsc" />
              <SortAscendingOutlined v-else class="th-sort-hint" />
            </span>
            <div
              class="th-stats-pill"
              :class="{ 'is-selection-active': (selectedCount || 0) > 0 }"
              :title="(selectedCount || 0) > 0 ? '按 ESC 或点击清空选区' : undefined"
              @click.stop="(selectedCount || 0) > 0 ? emit('clearSelection') : undefined"
            >
              <template v-if="(selectedCount || 0) > 0">
                <span class="pill-total">已选 {{ selectedCount }} 项</span>
                <span class="pill-detail">按 ESC 清空</span>
              </template>
              <template v-else>
                <span class="pill-total">{{ entries.length }} 项</span>
                <span class="pill-detail">包含 {{ dirCount }} 个目录，{{ fileCount }} 个文件</span>
              </template>
            </div>
            <span v-if="truncated" class="th-truncated-tag">已截取前 500 项</span>
          </div>
        </template>

        <!-- 表头：大小（靠右对齐与排序） -->
        <template #size-header>
          <div class="interactive-th is-right" @click="emit('toggleSort', 'size')">
            <span class="th-sort-icon" :class="{ 'is-active': sortField === 'size' }">
              <SortAscendingOutlined v-if="sortField === 'size' && sortAsc" />
              <SortDescendingOutlined v-else-if="sortField === 'size' && !sortAsc" />
              <SortAscendingOutlined v-else class="th-sort-hint" />
            </span>
            <span class="th-title-label" :class="{ 'is-sorted': sortField === 'size' }">大小</span>
          </div>
        </template>

        <!-- 表头：修改时间（居中对齐与排序） -->
        <template #mtime-header>
          <div class="interactive-th is-center" @click="emit('toggleSort', 'mtime')">
            <span class="th-title-label" :class="{ 'is-sorted': sortField === 'mtime' }">修改时间</span>
            <span class="th-sort-icon" :class="{ 'is-active': sortField === 'mtime' }">
              <SortAscendingOutlined v-if="sortField === 'mtime' && sortAsc" />
              <SortDescendingOutlined v-else-if="sortField === 'mtime' && !sortAsc" />
              <SortAscendingOutlined v-else class="th-sort-hint" />
            </span>
          </div>
        </template>

        <template #name="{ row }">
          <div class="file-name-cell group" @contextmenu.prevent="emit('rowContextMenu', row, $event)">
            <div class="file-icon-badge" :class="getFileVisualBadge(row.name, row.type).category">
              <ArrowUpOutlined v-if="row.type === 'parent_dir'" />
              <FolderFilled v-else-if="row.type === 'directory'" />
              <span v-else class="ext-name">{{ getFileVisualBadge(row.name, row.type).tag }}</span>
            </div>
            <span class="file-title-text" :title="row.name">{{ row.name }}</span>
            <span v-if="row.type === 'directory'" class="dir-badge">目录</span>
          </div>
        </template>
        <template #action="{ row }">
          <div class="row-actions-group">
            <YButton v-if="row.type === 'directory'" size="small" class="action-capsule-btn primary" @click.stop="emit('drillDown', row.name)">进入</YButton>
            <YButton v-else-if="row.type === 'parent_dir'" size="small" class="action-capsule-btn" @click.stop="emit('navigateUp')">返回</YButton>
            <YButton v-else size="small" class="action-capsule-btn" @click.stop="emit('preview', row)">预览</YButton>
          </div>
        </template>
      </YTable>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
