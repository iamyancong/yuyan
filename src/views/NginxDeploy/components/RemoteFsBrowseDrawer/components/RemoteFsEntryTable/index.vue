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

defineOptions({ name: 'RemoteFsEntryTable' });

interface RemoteFsEntryTableProps {
  entries: RemoteFsEntry[];
  loading: boolean;
  truncated: boolean;
  dirCount: number;
  fileCount: number;
  sortField: FsSortField;
  sortAsc: boolean;
}

const props = defineProps<RemoteFsEntryTableProps>();
const emit = defineEmits<{
  (e: 'rowClick', entry: RemoteFsEntry): void;
  (e: 'rowDblclick', entry: RemoteFsEntry): void;
  (e: 'rowContextMenu', entry: RemoteFsEntry, event: MouseEvent): void;
  (e: 'navigateUp'): void;
  (e: 'drillDown', name: string): void;
  (e: 'preview', entry: RemoteFsEntry): void;
  (e: 'toggleSort', field: FsSortField): void;
}>();

const tableAreaRef = ref<HTMLElement>();
const { tableHeight, isReady } = useTableHeight(tableAreaRef, {
  minHeight: 240,
  defaultHeight: 460,
});

/** 表格区域原生上下文菜单拦截：智能定位点击行并触发右键事件。 */
const handleAreaContextMenu = (event: MouseEvent) => {
  event?.preventDefault?.();
  const target = event.target as HTMLElement | null;
  if (!target) return;
  const rowEl = target.closest('.vxe-body--row');
  if (!rowEl) return;

  // 1. 优先通过 rowid 属性精准定位
  const rowId = rowEl.getAttribute('rowid');
  let matched = props.entries.find((e: RemoteFsEntry) => String(e.name) === rowId);

  // 2. 兜底：通过在 tbody 中的行索引定位
  if (!matched && rowEl.parentElement) {
    const trList = Array.from(rowEl.parentElement.querySelectorAll('.vxe-body--row'));
    const index = trList.indexOf(rowEl);
    if (index >= 0 && index < props.entries.length) {
      matched = props.entries[index];
    }
  }

  if (matched) {
    emit('rowContextMenu', matched, event);
  }
};
</script>

<template>
  <div class="remote-fs-table-wrap">
    <!-- 表格区域 -->
    <div ref="tableAreaRef" class="remote-fs-table-area" @contextmenu.prevent="handleAreaContextMenu">
      <YTable
        v-if="isReady"
        :data="entries"
        :columns="fsTableColumns"
        :loading="loading"
        :pageable="false"
        :height="tableHeight"
        :border="false"
        :row-config="{ keyField: 'name', isCurrent: true, isHover: true }"
        @cell-click="({ row }: any) => emit('rowClick', row as RemoteFsEntry)"
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
            <div class="th-stats-pill" @click.stop>
              <span class="pill-total">{{ entries.length }} 项</span>
              <span class="pill-detail">包含 {{ dirCount }} 个目录，{{ fileCount }} 个文件</span>
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
