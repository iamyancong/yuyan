import { h, ref } from 'vue';
import { notification, message } from 'ant-design-vue';
import { AppleFilled, CopyOutlined, CheckOutlined } from '@ant-design/icons-vue';
import { createGlassCloseIcon } from '@/utils/globalNotification';
import { MAC_QUARANTINE_COMMAND } from '../constant';

/**
 * 复制命令到系统剪贴板。
 * @param command - 待复制文本
 */
const copyToClipboard = async (command: string): Promise<boolean> => {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(command);
      return true;
    }
    const textarea = document.createElement('textarea');
    textarea.value = command;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(textarea);
    return successful;
  } catch (e) {
    console.error('[MacNotification] 复制失败:', e);
    return false;
  }
};

/**
 * 弹出符合雨燕 C4D 玻璃拟态设计风格的 macOS Gatekeeper 首次安装提示通知。
 */
export const showMacQuarantineNotification = () => {
  const isCopied = ref(false);

  const handleCopy = async () => {
    const success = await copyToClipboard(MAC_QUARANTINE_COMMAND);
    if (success) {
      isCopied.value = true;
      message.success('已复制解除隔离命令，请在终端粘贴运行');
      setTimeout(() => {
        isCopied.value = false;
      }, 2000);
    } else {
      message.error('复制失败，请手动选择复制');
    }
  };

  notification.open({
    key: 'yuyan-mac-quarantine-notification',
    class: 'yuyan-glass-notification',
    top: '76px', // 避开顶部 Header 区域
    duration: 8,
    placement: 'topRight',
    style: {
      width: '410px',
    },
    closeIcon: createGlassCloseIcon(),
    message: h('div', { class: 'glass-noti-title-wrap' }, [
      h('div', { class: 'glass-noti-icon-box' }, [
        h(AppleFilled, { class: 'glass-noti-apple-icon' }),
      ]),
      h('span', { class: 'glass-noti-title' }, 'macOS 首次安装安全提示'),
      h('span', { class: 'glass-noti-badge' }, 'Gatekeeper'),
    ]),
    description: h('div', { class: 'glass-noti-body' }, [
      h(
        'p',
        { class: 'glass-noti-desc' },
        '初次打开若提示「已损坏，无法打开」，请在系统终端 (Terminal) 粘贴执行：'
      ),
      h('div', { class: 'glass-noti-cmd-box' }, [
        h('div', { class: 'glass-noti-cmd-content' }, [
          h('span', { class: 'glass-noti-cmd-prompt' }, '$'),
          h('code', { class: 'glass-noti-cmd-code', title: MAC_QUARANTINE_COMMAND }, MAC_QUARANTINE_COMMAND),
        ]),
        h(
          'button',
          {
            type: 'button',
            class: 'glass-noti-btn-copy',
            onClick: handleCopy,
          },
          [
            h(CopyOutlined, { class: 'copy-icon' }),
            h('span', '复制命令'),
          ]
        ),
      ]),
      h(
        'div',
        { class: 'glass-noti-tip' },
        '粘贴回车后输入 Mac 开机密码即可正常启动'
      ),
    ]),
  });
};
