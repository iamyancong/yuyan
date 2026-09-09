import { computed, nextTick, ref, watch, type Ref } from 'vue';
import { useTableHeight } from '@yss-ui/hooks';
import type { NginxDeployTabKey } from '../types';

/** 表格初始高度，避免首次计算前页面抖动 */
const NGINX_DEPLOY_TABLE_DEFAULT_HEIGHT = 420;

/** 表格最小高度，保证小屏下仍可滚动查看 */
const NGINX_DEPLOY_TABLE_MIN_HEIGHT = 240;

/** 独立部署表格高度 Hook 参数 */
interface UseNginxDeployTableHeightParams {
  loading: Ref<boolean>;
  activeTabKey: Ref<NginxDeployTabKey>;
  targetDataLength: Ref<number>;
  serverDataLength: Ref<number>;
  recordDataLength: Ref<number>;
  recordPageSize: Ref<number>;
}

/**
 * 接入 YSS UI useTableHeight，管理独立部署三个 Tab 的表格高度。
 * @param params 高度计算依赖
 * @returns 三个表格区域 ref、高度和当前表格重算方法
 */
export const useNginxDeployTableHeight = (params: UseNginxDeployTableHeightParams) => {
  const targetTableAreaRef = ref<HTMLElement>();
  const serverTableAreaRef = ref<HTMLElement>();
  const recordTableAreaRef = ref<HTMLElement>();

  const { tableHeight: rawTargetTableHeight, recalculateHeight: recalculateTargetTableHeight } = useTableHeight(targetTableAreaRef, {
    minHeight: NGINX_DEPLOY_TABLE_MIN_HEIGHT,
    defaultHeight: NGINX_DEPLOY_TABLE_DEFAULT_HEIGHT,
  });
  const targetTableHeight = computed(() => {
    return rawTargetTableHeight.value > NGINX_DEPLOY_TABLE_MIN_HEIGHT ? rawTargetTableHeight.value : NGINX_DEPLOY_TABLE_MIN_HEIGHT;
  });

  const { tableHeight: rawServerTableHeight, recalculateHeight: recalculateServerTableHeight } = useTableHeight(serverTableAreaRef, {
    minHeight: NGINX_DEPLOY_TABLE_MIN_HEIGHT,
    defaultHeight: NGINX_DEPLOY_TABLE_DEFAULT_HEIGHT,
  });
  const serverTableHeight = computed(() => {
    return rawServerTableHeight.value > NGINX_DEPLOY_TABLE_MIN_HEIGHT ? rawServerTableHeight.value : NGINX_DEPLOY_TABLE_MIN_HEIGHT;
  });

  const { tableHeight: rawRecordTableHeight, recalculateHeight: recalculateRecordTableHeight } = useTableHeight(recordTableAreaRef, {
    minHeight: NGINX_DEPLOY_TABLE_MIN_HEIGHT,
    defaultHeight: NGINX_DEPLOY_TABLE_DEFAULT_HEIGHT,
    withPagination: true,
  });
  const recordTableHeight = computed(() => {
    return rawRecordTableHeight.value > NGINX_DEPLOY_TABLE_MIN_HEIGHT ? rawRecordTableHeight.value : NGINX_DEPLOY_TABLE_MIN_HEIGHT;
  });

  /**
   * 根据当前 Tab 重新计算对应表格高度。
   * @param tabKey Tab 标识
   */
  const recalculateTableHeight = (tabKey: NginxDeployTabKey = params.activeTabKey.value) => {
    const recalculateMap: Record<NginxDeployTabKey, () => void> = {
      targets: recalculateTargetTableHeight,
      servers: recalculateServerTableHeight,
      records: recalculateRecordTableHeight,
    };
    recalculateMap[tabKey]();
  };

  /**
   * 等待 DOM 更新后重新计算当前表格高度。
   */
  const recalculateAfterRender = async () => {
    await nextTick();
    recalculateTableHeight();
  };

  watch(params.activeTabKey, recalculateAfterRender, { flush: 'post' });
  watch(params.loading, async (value) => {
    if (!value) await recalculateAfterRender();
  });
  watch([params.targetDataLength, params.serverDataLength, params.recordDataLength, params.recordPageSize], recalculateAfterRender);

  return {
    targetTableAreaRef,
    serverTableAreaRef,
    recordTableAreaRef,
    targetTableHeight,
    serverTableHeight,
    recordTableHeight,
    recalculateTableHeight,
  };
};
