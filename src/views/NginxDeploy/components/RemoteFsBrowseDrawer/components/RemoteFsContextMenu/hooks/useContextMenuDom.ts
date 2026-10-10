/**
 * 远程文件系统右键菜单 DOM 浮层与全局事件调度 Hook
 * @description 负责计算视口边界智能定位、在全局捕获阶段高优先级拦截 ESC 键及外部指针点击防穿透
 */

import { computed, onMounted, onUnmounted, type CSSProperties, type Ref } from 'vue';

export interface UseContextMenuDomOptions {
  menuRef: Ref<HTMLElement | null>;
  visible: Ref<boolean>;
  x: Ref<number>;
  y: Ref<number>;
  onClose: () => void;
}

/**
 * 判定目标元素是否处于表格交互区域内部（表格空白、行、单元格）。
 * 仅在此区域内的点击才需要防穿透拦截，以避免误清空选区或误选行；
 * 表格外部（如顶部工具栏、路径输入框、搜索框、抽屉右上角关闭按钮、底部操作栏）照常放行。
 * @param target 目标 DOM 节点
 */
export function isTableAreaElement(target: unknown): boolean {
  if (!target || typeof (target as any).closest !== 'function') return false;
  return Boolean(
    (target as Element).closest(
      '.remote-fs-table-wrap, .remote-fs-table-area, .vxe-table'
    )
  );
}

/**
 * 判定键盘事件是否为退出操作并执行阻断。
 * @param event 键盘事件
 * @param isVisible 菜单是否处于打开态
 * @param onClose 关闭回调
 * @returns 是否命中并拦截了 ESC
 */
export function handleContextMenuKeyDown(
  event: KeyboardEvent,
  isVisible: boolean,
  onClose: () => void
): boolean {
  if (event.key === 'Escape' && isVisible) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    onClose();
    return true;
  }
  return false;
}

/**
 * 判定指针按下事件是否命中菜单外部并根据目标区域决定是否拦截。
 * @param event 鼠标/指针事件
 * @param isVisible 菜单是否处于打开态
 * @param menuEl 菜单容器 DOM
 * @param onClose 关闭回调
 * @param shouldInterceptPred 可选的目标判定谓词，默认判断是否处于表格区域
 * @returns 是否拦截并消费了事件（若在表格外部放行，虽触发 onClose 但返回 false）
 */
export function handleContextMenuPointerDown(
  event: MouseEvent,
  isVisible: boolean,
  menuEl: HTMLElement | null,
  onClose: () => void,
  shouldInterceptPred: (target: unknown) => boolean = isTableAreaElement
): boolean {
  if (event.button === 2) return false;
  if (isVisible && menuEl && !menuEl.contains(event.target as Node)) {
    // 无论点击哪个外部区域，菜单自身都应当关闭
    onClose();

    // 仅当点击落入表格交互区域时才执行拦截消费，防止误清空选区或误选行；
    // 其余区域（工具栏输入框、关闭按钮等）照常放行，确保一击即中聚焦或触发
    if (shouldInterceptPred(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
  }
  return false;
}

/**
 * 创建上下文菜单外部点击守卫状态机。
 * 负责精准追踪 Dismiss 标记、并在 pointerup 或下一次 pointerdown 时可靠重置，杜绝事件残留。
 */
export function createContextMenuPointerGuard(options: {
  isVisible: () => boolean;
  menuEl: () => HTMLElement | null;
  onClose: () => void;
  shouldIntercept?: (target: unknown) => boolean;
}) {
  let dismissedByPointer = false;
  let clearTimer: any = null;

  const reset = () => {
    dismissedByPointer = false;
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
  };

  /** 处理全局 pointerdown 捕获 */
  const handlePointerDown = (event: MouseEvent): boolean => {
    // 每次 pointerdown 进来，首先重置标记，防止先前未完成 click 的残留吞掉正常点击
    reset();

    const consumed = handleContextMenuPointerDown(
      event,
      options.isVisible(),
      options.menuEl(),
      options.onClose,
      options.shouldIntercept
    );

    if (consumed) {
      dismissedByPointer = true;
    }
    return consumed;
  };

  /** 处理全局 pointerup 捕获：在下一个 tick 清理标记，避免无对应 click 时残留 */
  const handlePointerUp = () => {
    if (dismissedByPointer) {
      clearTimer = setTimeout(() => {
        dismissedByPointer = false;
        clearTimer = null;
      }, 0);
    }
  };

  /** 处理全局 click 捕获：若本次点击已用于 Dismiss 表格区菜单，消费此 click 阻止穿透 */
  const handleClick = (event: MouseEvent): boolean => {
    if (dismissedByPointer) {
      reset();
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    return false;
  };

  return {
    handlePointerDown,
    handlePointerUp,
    handleClick,
    reset,
    isDismissed: () => dismissedByPointer,
  };
}

/**
 * 远程文件系统右键菜单 DOM 定位与事件拦截 Hook。
 * @param options 配置参数
 */
export function useContextMenuDom(options: UseContextMenuDomOptions) {
  const { menuRef, visible, x, y, onClose } = options;

  const pointerGuard = createContextMenuPointerGuard({
    isVisible: () => visible.value,
    menuEl: () => menuRef.value,
    onClose,
  });

  /**
   * 计算菜单智能定位样式，防止贴底或靠右超出视口边界。
   */
  const menuStyle = computed<CSSProperties>(() => {
    const menuWidth = 180;
    const menuHeight = 160;
    const padding = 12;

    let left = x.value;
    let top = y.value;

    if (typeof window !== 'undefined') {
      if (left + menuWidth > window.innerWidth - padding) {
        left = Math.max(padding, window.innerWidth - menuWidth - padding);
      }
      if (top + menuHeight > window.innerHeight - padding) {
        top = Math.max(padding, window.innerHeight - menuHeight - padding);
      }
    }

    return {
      left: `${left}px`,
      top: `${top}px`,
    };
  });

  /**
   * 捕获阶段按键监听：ESC 拥有最高优先级，立即关闭菜单并阻断下层选区清空与抽屉响应。
   */
  const handleKeyDownCapture = (event: KeyboardEvent) => {
    handleContextMenuKeyDown(event, visible.value, onClose);
  };

  /**
   * 滚动容器时自动收起右键菜单。
   */
  const handleScrollCapture = () => {
    if (visible.value) {
      onClose();
    }
  };

  onMounted(() => {
    window.addEventListener('pointerdown', pointerGuard.handlePointerDown, true);
    window.addEventListener('pointerup', pointerGuard.handlePointerUp, true);
    window.addEventListener('click', pointerGuard.handleClick, true);
    window.addEventListener('keydown', handleKeyDownCapture, true);
    window.addEventListener('scroll', handleScrollCapture, true);
  });

  onUnmounted(() => {
    pointerGuard.reset();
    window.removeEventListener('pointerdown', pointerGuard.handlePointerDown, true);
    window.removeEventListener('pointerup', pointerGuard.handlePointerUp, true);
    window.removeEventListener('click', pointerGuard.handleClick, true);
    window.removeEventListener('keydown', handleKeyDownCapture, true);
    window.removeEventListener('scroll', handleScrollCapture, true);
  });

  return {
    menuStyle,
  };
}
