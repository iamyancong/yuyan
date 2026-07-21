import { ref } from 'vue';
import { message } from 'ant-design-vue';

/**
 * 客户端与服务器数据同步的逻辑 Hook
 * @returns 包含同步状态 syncing 和触发同步的 confirmSyncData 函数
 */
export function useDataSync() {
  /** 是否正在同步数据 */
  const syncing = ref(false);

  /**
   * 刷新当前账号的脱敏配置缓存，不下载或覆盖 SQLite。
   */
  const confirmSyncData = async () => {
    syncing.value = true;
    try {
      window.dispatchEvent(new CustomEvent('yuyan-team-config-refresh', { detail: { timestamp: Date.now() } }));
      message.success({ content: '已刷新当前账号配置', key: 'account-config-refresh', duration: 2 });
    } finally {
      syncing.value = false;
    }
  };

  return {
    syncing,
    confirmSyncData
  };
}
