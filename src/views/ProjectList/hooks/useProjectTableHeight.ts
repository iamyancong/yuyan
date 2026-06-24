import { nextTick, ref, watch, type Ref } from 'vue';
import { useTableHeight } from '@yss-ui/hooks';

/** 项目列表表格外固定区域偏移：卡片头部、筛选区、卡片内边距与间距 */
const PROJECT_LIST_TABLE_OFFSET = 188;

/**
 * 接入 YSS UI useTableHeight，管理项目列表表格高度。
 * @param loading - 表格加载状态
 * @param dataLength - 表格数据长度
 * @param pageSize - 分页条数
 * @returns 表格区域 ref、高度和重算方法
 */
export const useProjectTableHeight = (loading: Ref<boolean>, dataLength: Ref<number>, pageSize: Ref<number>) => {
  const tableBoundaryRef = ref<HTMLElement>();
  const tableAreaRef = ref<HTMLElement>();
  const { tableHeight, recalculateHeight } = useTableHeight(tableAreaRef, {
    boundaryRef: tableBoundaryRef,
    withPagination: true,
    minHeight: 260,
    extraOffset: PROJECT_LIST_TABLE_OFFSET,
  });

  /**
   * 等待 DOM 更新后重新计算表格高度。
   */
  const recalculateAfterRender = async () => {
    await nextTick();
    recalculateHeight();
  };

  watch(loading, async (nv) => {
    if (!nv) await recalculateAfterRender();
  });
  watch(dataLength, recalculateAfterRender);
  watch(pageSize, recalculateAfterRender);

  return {
    tableBoundaryRef,
    tableAreaRef,
    tableHeight,
    recalculateHeight,
  };
};
