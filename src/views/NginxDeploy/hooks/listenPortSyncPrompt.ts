/**
 * 监听端口同步的询问弹窗（A：配置抽屉保存后；B：编辑表单「从 Nginx 配置同步」）。
 * @description 文案与决策都来自 nginxListenSyncPolicy 纯函数，这里只负责弹窗本身。
 */
import { h } from 'vue';
import { Modal } from 'ant-design-vue';
import { ExclamationCircleOutlined } from '@ant-design/icons-vue';
import { OVERLAY_Z_INDEX } from '../constant';
import {
  formatListenPortSyncConfirm,
  type ListenPortSuggestion,
  type ListenPortSyncPlan,
} from './nginxListenSyncPolicy';

/**
 * 询问是否把监听端口同步到部署目标。点确定才返回 true；取消或关闭返回 false。
 * @param suggestion `kind === 'suggest'` 的建议
 * @param plan 同步计划
 * @param okText 确定按钮文案
 */
export function confirmListenPortSync(
  suggestion: Extract<ListenPortSuggestion, { kind: 'suggest' }>,
  plan: ListenPortSyncPlan,
  okText = '同步到部署目标'
): Promise<boolean> {
  const lines = formatListenPortSyncConfirm(suggestion, plan);
  return new Promise((resolve) => {
    Modal.confirm({
      title: '同步监听端口',
      icon: h(ExclamationCircleOutlined),
      zIndex: OVERLAY_Z_INDEX.modalAboveDrawer,
      content: h(
        'div',
        lines.map((line, index) => h('p', { style: index === lines.length - 1 ? 'margin: 0' : 'margin: 0 0 6px', 'data-testid': `listen-port-sync-line-${index}` }, line))
      ),
      okText,
      cancelText: '取消',
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}
