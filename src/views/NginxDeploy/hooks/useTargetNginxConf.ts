import { ref } from 'vue';
import message from 'ant-design-vue/es/message';
import { saveNginxConf, testNginxConf, type DeployTarget } from '@/api/deploy';
import { useNginxDeployContext } from './useNginxDeployContext';

/**
 * 管理部署目标的 Nginx 配置文件操作。
 * @description 抽离自巨无霸 Hook，专门负责配置文件的读取、保存备份与 nginx -t 在线测试校验。
 * @param ensureTargetIdle 依赖的校验目标空闲方法
 * @returns Nginx 当前目标 ID、打开、保存与测试方法
 */
export function useTargetNginxConf(
  ensureTargetIdle: (target: Pick<DeployTarget, 'id' | 'projectName'>, operationLabel: string) => Promise<boolean>,
  ensureLoggedIn?: () => boolean
) {
  // 安全的鉴权判断方法
  const runEnsureLoggedIn = () => {
    if (ensureLoggedIn) return ensureLoggedIn();
    try {
      return useNginxDeployContext().ensureLoggedIn();
    } catch {
      return false;
    }
  };

  /** 当前正在查看/修改 Nginx 配置的部署目标 ID */
  const nginxTargetId = ref<number | null>(null);

  /**
   * 打开 Nginx 配置抽屉。
   * @param target 部署目标
   */
  const openNginxConfig = (target: DeployTarget) => {
    if (!runEnsureLoggedIn()) return;
    void ensureTargetIdle(target, '修改 Nginx 配置').then((idle) => {
      if (idle) nginxTargetId.value = target.id;
    });
  };

  /**
   * 保存 Nginx 配置文件。
   * @param targetId 部署目标 ID
   * @param content 配置内容
   * @param done 完成回调
   */
  const handleSaveNginxConf = async (targetId: number, content: string, done?: (error?: unknown) => void) => {
    if (!runEnsureLoggedIn()) {
      done?.(new Error('请先登录后再保存 Nginx 配置文件'));
      return;
    }
    try {
      const result = await saveNginxConf(targetId, content, true);
      message.success(`Nginx 配置文件已保存，备份：${result.backupPath}`);
      done?.();
    } catch (error) {
      done?.(error);
    }
  };

  /**
   * 测试 Nginx 配置文件。
   * @param targetId 部署目标 ID
   * @param done 完成回调
   */
  const handleTestNginxConf = async (targetId: number, done?: (error?: unknown) => void) => {
    if (!runEnsureLoggedIn()) {
      done?.(new Error('请先登录后再校验 Nginx 配置文件'));
      return;
    }
    try {
      const result = await testNginxConf(targetId);
      message.success(result.output || 'nginx -t 校验通过');
      done?.();
    } catch (error) {
      done?.(error);
    }
  };

  return {
    nginxTargetId,
    openNginxConfig,
    handleSaveNginxConf,
    handleTestNginxConf,
  };
}
