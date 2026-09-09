import { computed, nextTick, ref, watch, type Ref } from 'vue';
import { useTableHeight } from '@yss-ui/hooks';
import type { DeployRecord } from '@/api/deploy';
import { buildCommitUrl, TABLE_DEFAULT_HEIGHT, TABLE_MIN_HEIGHT } from '../constant';

/** 发布历史 Tab Hook 入参 */
interface UseDeployRecordTabOptions {
  /** 激活状态 */
  active: Ref<boolean>;
  /** 加载中状态 */
  loading: Ref<boolean>;
  /** 发布记录列表 */
  records: Ref<DeployRecord[]>;
  /** 分页大小 */
  pageSize: Ref<number>;
}

/**
 * 发布历史 Tab 逻辑 Hook
 * @param options 参数配置
 * @returns 表格高度与提交链接方法
 */
export function useDeployRecordTab(options: UseDeployRecordTabOptions) {
  const tableAreaRef = ref<HTMLElement>();

  const { tableHeight: rawTableHeight, recalculateHeight } = useTableHeight(tableAreaRef, {
    minHeight: TABLE_MIN_HEIGHT,
    defaultHeight: TABLE_DEFAULT_HEIGHT,
    withPagination: true,
  });

  /** 限制表格最小高度，避免 hook 内部 availableHeight <= minHeight 时 fallback 到 0 的 Bug */
  const tableHeight = computed(() => {
    return rawTableHeight.value > TABLE_MIN_HEIGHT ? rawTableHeight.value : TABLE_MIN_HEIGHT;
  });

  /** 等待视图更新后重新计算表格高度（仅在当前 Tab 激活时执行，避免后台强制回流） */
  const recalculateAfterRender = async () => {
    if (!options.active.value) return;
    await nextTick();
    recalculateHeight();
  };

  watch([options.loading, () => options.records.value.length, options.pageSize], recalculateAfterRender, {
    flush: 'post',
  });

  watch(
    options.active,
    (isActive) => {
      if (isActive) {
        void recalculateAfterRender();
      }
    },
    { flush: 'post' }
  );

  /** 提交链接映射 */
  const commitUrlMap = computed(() => {
    const map = new Map<number, string>();
    options.records.value.forEach((record) => {
      map.set(record.id, buildCommitUrl(record));
    });
    return map;
  });

  /**
   * 获取单行记录的 GitLab 提交链接。
   * @param record 发布记录
   * @returns GitLab 提交详情链接
   */
  const getCommitUrl = (record: DeployRecord): string => {
    return commitUrlMap.value.get(record.id) || '';
  };

  return {
    tableAreaRef,
    tableHeight,
    recalculateAfterRender,
    getCommitUrl,
  };
}
