<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { YTable } from '@yss-ui/components/lite';
import { useTableHeight } from '@yss-ui/hooks';
import type { YTableActionConfig } from '@yss-ui/components/lite';
import type { DeployServer } from '@/api/deploy';
import { serverColumns } from '../../constant';

defineOptions({ name: 'DeployServerTab' });

/** 表格默认高度 */
const TABLE_DEFAULT_HEIGHT = 420;

/** 表格最小高度 */
const TABLE_MIN_HEIGHT = 240;

/** 服务器管理 Tab 属性 */
interface DeployServerTabProps {
  active?: boolean;
  loading: boolean;
  orderSaving: boolean;
  servers: DeployServer[];
  actionConfig: YTableActionConfig;
}

const props = defineProps<DeployServerTabProps>();
const emit = defineEmits<{
  /** 保存拖拽后的服务器顺序 */
  (event: 'reorder', servers: DeployServer[]): void;
}>();

const tableAreaRef = ref<HTMLElement>();
const tableData = ref<DeployServer[]>([]);
const { tableHeight: rawTableHeight, recalculateHeight } = useTableHeight(tableAreaRef, {
  minHeight: TABLE_MIN_HEIGHT,
  defaultHeight: TABLE_DEFAULT_HEIGHT,
});

/** 限制表格最小高度，避免 hook 内部 availableHeight <= minHeight 时 fallback 到 0 的 Bug */
const tableHeight = computed(() => {
  return rawTableHeight.value > TABLE_MIN_HEIGHT ? rawTableHeight.value : TABLE_MIN_HEIGHT;
});

/** 是否允许拖拽排序（服务器存在时即可展示把手并排序） */
const isDragable = computed(() => {
  return tableData.value.length > 0 && !props.orderSaving;
});

/** 等待视图更新后重新计算表格高度（仅在当前 Tab 激活时执行，避免后台强制回流） */
const recalculateAfterRender = async () => {
  if (props.active === false) return;
  await nextTick();
  recalculateHeight();
};

/**
 * 拖拽状态追踪（解决 macOS WKWebView 向上拖拽时底层 dragleave 清空事件导致 API 未触发的 Bug）
 */
let dragSourceServer: DeployServer | null = null;
let dragTargetServer: DeployServer | null = null;
let dragInsertPos: 'top' | 'bottom' = 'top';

/**
 * 隐藏拖拽浮盒/指示线并还原所有节点的样式与透明度
 */
const clearVxeDragStatus = () => {
  if (!tableAreaRef.value || props.active === false) return;

  // 1. 隐藏残留的拖拽 Tip 浮盒与指示线
  const tipEl = tableAreaRef.value.querySelector('.vxe-table--drag-sort-tip') as HTMLElement | null;
  if (tipEl) {
    tipEl.style.display = 'none';
  }
  const lineEl = tableAreaRef.value.querySelector('.vxe-table--drag-row-line') as HTMLElement | null;
  if (lineEl) {
    lineEl.style.display = 'none';
  }

  // 2. 清除节点的拖拽残留类与透明度
  const targetEls = tableAreaRef.value.querySelectorAll(
    'tr, td, th, .vxe-body--row, .vxe-body--column, .vxe-cell, .vxe-table--body-wrapper'
  );
  targetEls.forEach((el) => {
    const htmlEl = el as HTMLElement;
    if (htmlEl.style.opacity) htmlEl.style.opacity = '';
    if (htmlEl.style.filter) htmlEl.style.filter = '';
    if (htmlEl.style.transform && htmlEl.style.transform.includes('translate')) htmlEl.style.transform = '';
    el.classList.remove(
      'row--drag-over',
      'is--drag-over',
      'row--drag-source',
      'is--drag-source',
      'vxe-drag--source',
      'row--drag-dropped',
      'is--drag',
      'row--drag',
      'drag--source',
      'drag--hover',
      'vxe-body--row-drag'
    );
  });
};

/** 拖拽结束后清理视觉残影（仅在实际拖拽操作完成时触发） */
const cleanupDragArtifacts = () => {
  clearVxeDragStatus();
  requestAnimationFrame(() => clearVxeDragStatus());
};

watch([() => props.loading, () => props.servers.length], recalculateAfterRender, { flush: 'post' });

watch(
  () => props.active,
  (isActive) => {
    if (isActive) {
      void recalculateAfterRender();
    }
  },
  { flush: 'post' }
);

watch(
  () => props.servers,
  (servers) => {
    tableData.value = [...servers];
  },
  { immediate: true }
);

const handleAreaDragStart = (e: DragEvent) => {
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const tr = target.closest('tr');
  if (tr) {
    const rowId = tr.getAttribute('rowid') || tr.dataset.rowid;
    if (rowId) {
      dragSourceServer = tableData.value.find((s) => String(s.id) === String(rowId)) || null;
    }
  }
};

const handleAreaDragOver = (e: DragEvent) => {
  e.preventDefault();
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'move';
  }
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const tr = target.closest('tr');
  if (tr) {
    const rowId = tr.getAttribute('rowid') || tr.dataset.rowid;
    if (rowId) {
      const server = tableData.value.find((s) => String(s.id) === String(rowId));
      if (server) {
        dragTargetServer = server;
        const rect = tr.getBoundingClientRect();
        dragInsertPos = e.clientY - rect.top < rect.height / 2 ? 'top' : 'bottom';
      }
    }
  }
};

/** 执行重排序并触发后端 API 接口 */
const executeReorder = (source: DeployServer, target: DeployServer, pos: 'top' | 'bottom') => {
  if (!source || !target || source.id === target.id) return;

  const list = [...tableData.value];
  const sourceIndex = list.findIndex((s) => s.id === source.id);
  if (sourceIndex === -1) return;

  const [movedServer] = list.splice(sourceIndex, 1);
  let targetIndex = list.findIndex((s) => s.id === target.id);
  if (targetIndex === -1) return;

  if (pos === 'bottom') {
    targetIndex += 1;
  }

  list.splice(targetIndex, 0, movedServer);

  const isChanged = list.some((s, idx) => s.id !== tableData.value[idx]?.id);
  if (isChanged) {
    tableData.value = [...list];
    emit('reorder', [...list]);
  }
};

const handleAreaDrop = (e: DragEvent) => {
  e.preventDefault();
  if (dragSourceServer && dragTargetServer && dragSourceServer.id !== dragTargetServer.id) {
    executeReorder(dragSourceServer, dragTargetServer, dragInsertPos);
  }
  dragSourceServer = null;
  dragTargetServer = null;
  cleanupDragArtifacts();
};

const handleAreaDragEnd = () => {
  dragSourceServer = null;
  dragTargetServer = null;
  cleanupDragArtifacts();
};

/**
 * 处理 vxe-table 原生 row-dragend 事件
 */
const handleRowDragEnd = (params: any) => {
  const data = params?.data;
  const oldRow = params?.oldRow || params?.dragRow;
  const newRow = params?.newRow || params?.targetRow;
  const dragPos = params?.dragPos || 'top';

  if (Array.isArray(data) && data.length > 0) {
    const isChanged = data.some((s: any, idx: number) => s.id !== tableData.value[idx]?.id);
    if (isChanged) {
      tableData.value = [...data];
      emit('reorder', [...data]);
      cleanupDragArtifacts();
      return;
    }
  }

  if (oldRow && newRow) {
    executeReorder(oldRow, newRow, dragPos);
  }
  cleanupDragArtifacts();
};
</script>

<template>
  <div class="nginx-deploy-tab-pane">
    <div
      ref="tableAreaRef"
      class="nginx-deploy-table-area"
      @dragstart="handleAreaDragStart"
      @dragover="handleAreaDragOver"
      @drop="handleAreaDrop"
      @dragend="handleAreaDragEnd"
    >
      <YTable
        v-model:data="tableData"
        :columns="serverColumns"
        :loading="loading"
        :action-config="actionConfig"
        :max-height="tableHeight"
        :row-config="{ keyField: 'id', useKey: true, drag: isDragable }"
        :row-dragable="isDragable"
        :pageable="false"
        size="small"
        id="nginx-deploy-servers"
        @row-dragend="handleRowDragEnd"
      />
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
