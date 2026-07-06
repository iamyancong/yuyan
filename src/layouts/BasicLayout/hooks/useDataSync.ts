import { ref } from 'vue';
import { message, Modal } from 'ant-design-vue';
import { backupDbFromServer, restoreDbToLocal } from '@/api/deploy';

/**
 * 客户端与服务器数据同步的逻辑 Hook
 * @returns 包含同步状态 syncing 和触发同步的 confirmSyncData 函数
 */
export function useDataSync() {
  /** 是否正在同步数据 */
  const syncing = ref(false);

  /**
   * 弹出同步确认弹窗，若用户确认则从测试环境拉取 SQLite 数据库并覆盖写入本地
   */
  const confirmSyncData = () => {
    Modal.confirm({
      title: '同步测试环境数据到本地',
      content: `确定要拉取测试环境（${import.meta.env.VITE_APP_SERVER_URL || ''}）的最新数据库并覆盖本地吗？此操作不可逆，本地现有的所有配置和服务器数据将被完全覆盖。`,
      okText: '确认同步',
      cancelText: '取消',
      onOk: async () => {
        syncing.value = true;
        try {
          message.loading({ content: '正在从测试环境下载数据...', key: 'db-sync', duration: 0 });
          // 1. 下载测试环境数据库二进制数据
          const dbData = await backupDbFromServer(import.meta.env.VITE_APP_SERVER_URL || '');
          
          message.loading({ content: '正在写入本地数据库并重新挂载...', key: 'db-sync', duration: 0 });
          // 2. 还原数据覆盖本地 SQLite 文件
          const result = await restoreDbToLocal(dbData);
          
          if (result && result.success) {
            message.success({ content: '数据同步成功！正在刷新页面...', key: 'db-sync', duration: 2 });
            setTimeout(() => {
              window.location.reload();
            }, 1500);
          } else {
            throw new Error(result?.message || '未知错误');
          }
        } catch (error: any) {
          console.error('数据同步失败:', error);
          message.error({ 
            content: `数据同步失败: ${error.message || '网络连接超时，请确保测试环境服务运行正常'}`, 
            key: 'db-sync', 
            duration: 5 
          });
        } finally {
          syncing.value = false;
        }
      }
    });
  };

  return {
    syncing,
    confirmSyncData
  };
}
