import { ref } from 'vue';
import { message } from 'ant-design-vue';
import { refreshCentralData } from '@/services/centralDataRefresh';

/**
 * 提取中央数据刷新错误文案。
 * @param error 请求错误
 * @returns 可展示错误信息
 */
const getRefreshErrorMessage = (error: unknown): string => {
  if (error && typeof error === 'object') {
    const responseMessage = (error as { response?: { data?: { error?: string | { message?: string }; message?: string } } })
      .response?.data;
    if (typeof responseMessage?.error === 'string') return responseMessage.error;
    if (responseMessage?.error && typeof responseMessage.error === 'object' && responseMessage.error.message) {
      return responseMessage.error.message;
    }
    if (responseMessage?.message) return responseMessage.message;
  }
  return error instanceof Error ? error.message : String(error || '未知错误');
};

/**
 * 客户端与服务器数据同步的逻辑 Hook
 * @returns 包含同步状态 syncing 和触发同步的 confirmSyncData 函数
 */
export function useDataSync() {
  /** 是否正在同步数据 */
  const syncing = ref(false);

  /**
   * 刷新当前页面中央数据，不下载或覆盖 SQLite。
   */
  const confirmSyncData = async () => {
    if (syncing.value) return;
    syncing.value = true;
    try {
      const result = await refreshCentralData();
      if (!result.handlerCount) {
        message.info({ content: '当前页面暂无可刷新的中央数据', key: 'central-data-refresh', duration: 2 });
        return;
      }
      message.success({ content: '中央数据已刷新', key: 'central-data-refresh', duration: 2 });
    } catch (error) {
      message.error({ content: `刷新中央数据失败：${getRefreshErrorMessage(error)}`, key: 'central-data-refresh', duration: 4 });
    } finally {
      syncing.value = false;
    }
  };

  return {
    syncing,
    confirmSyncData,
  };
}
