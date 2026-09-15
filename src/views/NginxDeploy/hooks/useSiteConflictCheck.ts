import { createVNode } from 'vue';
import { Modal } from 'ant-design-vue';
import { ExclamationCircleOutlined } from '@ant-design/icons-vue';
import type { DeployTarget } from '@/api/deploy';
import {
  checkSiteConflict,
  type SiteConflictDraft,
  type SiteConflictResult,
} from './siteConflictPolicy';

export { checkSiteConflict };
export type { SiteConflictDraft, SiteConflictResult };

/**
 * Hook：提供交互式冲突预警确认弹窗。
 */
export function useSiteConflictCheck() {
  /**
   * 预检冲突并弹窗确认。若无冲突直接通过，若有冲突则弹窗让用户选择。
   * @param draft 目标草稿
   * @param allTargets 全量目标列表
   * @returns 用户是否决定继续
   */
  const confirmIfConflict = (draft: SiteConflictDraft, allTargets: DeployTarget[] = []): Promise<boolean> => {
    const result = checkSiteConflict(draft, allTargets);
    if (!result.hasConflict || !result.conflictedTarget) {
      return Promise.resolve(true);
    }

    const conflict = result.conflictedTarget;
    return new Promise((resolve) => {
      Modal.confirm({
        title: '站点路由冲突预警（Nginx 端口与域名占用）',
        icon: createVNode(ExclamationCircleOutlined),
        content: `域名 "${draft.nginxServerName}" 和端口 ${draft.listenPort} 目前已被部署目标【${conflict.projectName} (${conflict.defaultBranch})】占用。在同一 Nginx 实例下配置相同的域名与端口可能导致 Nginx reload 路由重叠或覆盖。是否确认仍然继续保存？`,
        okText: '仍然继续保存',
        cancelText: '取消修改',
        okType: 'danger',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  };

  return {
    checkSiteConflict,
    confirmIfConflict,
  };
}
