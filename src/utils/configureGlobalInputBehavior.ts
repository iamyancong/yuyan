/**
 * 全局输入框安全行为配置模块
 * @description 针对 macOS / iOS 等环境，全局抑制输入框自动首字母大写、自动拼写纠错和内联预测胶囊浮窗。
 */

/**
 * 为目标元素注入禁用自动大写和拼写纠错的 HTML 属性。
 * @param element 目标输入元素
 */
function applySafeInputAttributes(element: HTMLElement): void {
  const tagName = element.tagName?.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea' || element.isContentEditable) {
    if (element.getAttribute('autocapitalize') !== 'none') {
      element.setAttribute('autocapitalize', 'none');
    }
    if (element.getAttribute('autocorrect') !== 'off') {
      element.setAttribute('autocorrect', 'off');
    }
    if (element.getAttribute('spellcheck') !== 'false') {
      element.setAttribute('spellcheck', 'false');
    }
  }
}

/**
 * 初始化全局输入框行为控制器。
 * 在 document 捕获阶段监听 focusin 和 input 事件，确保所有动态创建的输入框（包括 AntDV Select/Input、Formily 等）均被覆盖。
 */
export function configureGlobalInputBehavior(): void {
  if (typeof document === 'undefined') return;

  // 1. 焦点进入时立即注入属性（优先在输入法激活前拦截）
  document.addEventListener(
    'focusin',
    (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (target) applySafeInputAttributes(target);
    },
    true
  );

  // 2. 针对页面中已渲染好的输入框做初始标记
  const markExistingInputs = () => {
    try {
      const elements = document.querySelectorAll<HTMLElement>('input, textarea, [contenteditable="true"]');
      elements.forEach(applySafeInputAttributes);
    } catch {
      // 容错处理
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', markExistingInputs, { once: true });
  } else {
    markExistingInputs();
  }
}
