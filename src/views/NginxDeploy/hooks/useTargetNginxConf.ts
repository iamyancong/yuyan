import { ref } from 'vue';
import message from 'ant-design-vue/es/message';
import { saveNginxConf, testNginxConf, type DeployTarget, type NginxConfSaveOptions, type NginxConfSaveResult } from '@/api/deploy';
import { useNginxDeployContext } from './useNginxDeployContext';

/**
 * 管理部署目标的 Nginx 配置文件操作。
 * @description 抽离自巨无霸 Hook，专门负责配置文件的读取、保存备份与 nginx -t 在线测试校验。
 * @param ensureTargetIdle 依赖的校验目标空闲方法
 * @returns Nginx 当前目标 ID、打开、保存与测试方法
 */
export function useTargetNginxConf(
  ensureTargetIdle: (target: Pick<DeployTarget, 'id' | 'projectName' | 'projectType'>, operationLabel: string) => Promise<boolean>,
  ensureLoggedIn?: () => boolean,
  options?: {
    /** 「保存并重载」成功后回调（抽屉已结束 loading），用于询问是否同步监听端口 */
    onConfigSaved?: (targetId: number, content: string, previousContent?: string) => void;
  }
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
  let nginxConfigOpenSequence = 0;

  /**
   * 打开 Nginx 配置抽屉。
   * @param target 部署目标
   */
  const openNginxConfig = (target: DeployTarget) => {
    if (!runEnsureLoggedIn()) return;
    nginxConfigOpenSequence += 1;
    const currentSeq = nginxConfigOpenSequence;
    nginxTargetId.value = target.id;
    void ensureTargetIdle(target, '修改 Nginx 配置').then((idle) => {
      if (currentSeq !== nginxConfigOpenSequence) return;
      if (!idle && nginxTargetId.value === target.id) {
        nginxTargetId.value = null;
      }
    });
  };

  /**
   * 保存 Nginx 配置文件。
   * @param targetId 部署目标 ID
   * @param content 配置内容
   * @param done 完成回调（成功时带保存结果）
   * @param previousContent 保存前的配置基线
   * @param saveOptions 乐观锁摘要与历史恢复来源
   */
  const handleSaveNginxConf = async (
    targetId: number,
    content: string,
    done?: (error?: unknown, result?: NginxConfSaveResult) => void,
    previousContent?: string,
    saveOptions?: NginxConfSaveOptions
  ) => {
    if (!runEnsureLoggedIn()) {
      done?.(new Error('请先登录后再保存 Nginx 配置文件'));
      return;
    }
    try {
      const result = await saveNginxConf(targetId, content, true, saveOptions || {});
      if (result.skipped) {
        message.success('Nginx 配置内容未变化，未生成新备份');
      } else if (result.backupPath) {
        message.success(`Nginx 配置文件已保存，备份：${result.backupPath}`);
      } else {
        message.success('Nginx 配置文件已保存');
      }
      done?.(undefined, result);
    } catch (error) {
      done?.(error);
      return;
    }
    options?.onConfigSaved?.(targetId, content, previousContent);
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
