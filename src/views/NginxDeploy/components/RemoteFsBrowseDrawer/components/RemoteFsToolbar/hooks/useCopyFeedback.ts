/**
 * 路径复制瞬态视觉反馈 Hook
 */

import { ref } from 'vue';

/**
 * 管理复制按钮的轻量成功动效与倒计时重置。
 * @param onCopy 复制操作回调
 */
export function useCopyFeedback(onCopy: () => void) {
  const isCopied = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const triggerCopy = () => {
    onCopy();
    isCopied.value = true;
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      isCopied.value = false;
      timer = null;
    }, 1500);
  };

  return {
    isCopied,
    triggerCopy,
  };
}
