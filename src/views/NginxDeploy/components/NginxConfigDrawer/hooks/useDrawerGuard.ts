import { type Ref } from 'vue';
import { Modal } from 'ant-design-vue';

/**
 * Nginx 抽屉关闭安全守卫 Hook
 * 拦截未保存状态下的抽屉关闭动作，提示用户放弃修改或继续编辑。
 * @param isDirty 脏状态标识 Ref
 * @param onDiscard 确认放弃修改回调
 * @param onClose 执行关闭抽屉回调
 */
export function useDrawerGuard(
  isDirty: Ref<boolean>,
  onDiscard: () => void,
  onClose: () => void
) {
  /**
   * 请求关闭抽屉（受保护）
   */
  const requestClose = () => {
    if (!isDirty.value) {
      onClose();
      return;
    }

    Modal.confirm({
      title: '放弃未保存的修改？',
      content: '当前 Nginx 配置文件存在未保存的修改，关闭后将丢失这些变更。',
      okText: '放弃修改',
      okType: 'danger',
      cancelText: '继续编辑',
      onOk: () => {
        onDiscard();
        onClose();
      },
    });
  };

  return {
    requestClose,
  };
}
