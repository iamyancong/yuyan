<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { YTable } from '@ycwang-dev/components/lite';
import { useTableHeight } from '@ycwang-dev/hooks';
import type { YTableActionConfig } from '@ycwang-dev/components/lite';
import type { DeployServer } from '@/api/deploy';
import { serverColumns } from '../../constant';

defineOptions({ name: 'DeployServerTab' });

/** 表格默认高度 */
const TABLE_DEFAULT_HEIGHT = 420;

/** 表格最小高度 */
const TABLE_MIN_HEIGHT = 240;

/** 服务器管理 Tab 属性 */
interface DeployServerTabProps {
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

/** 是否允许拖拽排序 */
const isDragable = computed(() => {
  return tableData.value.length > 1 && !props.loading && !props.orderSaving;
});

/** 等待视图更新后重新计算表格高度 */
const recalculateAfterRender = async () => {
  await nextTick();
  recalculateHeight();
};

watch([() => props.loading, () => props.servers.length], recalculateAfterRender, { flush: 'post' });
watch(
  () => props.servers,
  (servers) => {
    tableData.value = [...servers];
  },
  { immediate: true }
);

/**
 * 提交拖拽后的服务器顺序。
 * @param servers 排序后的服务器列表
 */
const handleRowDragEnd = (servers: DeployServer[]) => {
  tableData.value = [...servers];
  emit('reorder', [...servers]);
};
</script>

<template>
  <div class="nginx-deploy-tab-pane">
    <div ref="tableAreaRef" class="nginx-deploy-table-area">
      <YTable
        v-model:data="tableData"
        :columns="serverColumns"
        :loading="loading"
        :action-config="actionConfig"
        :max-height="tableHeight"
        :row-config="{ keyField: 'id', useKey: true }"
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
