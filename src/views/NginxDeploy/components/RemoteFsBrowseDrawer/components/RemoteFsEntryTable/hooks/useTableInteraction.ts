/**
 * 表格交互与选区控制 Hook
 * @description 封装表格容器的键盘快捷键（全选/清空）、Shift 选区拦截、空白点击清空及右键菜单定位
 */

import type { Ref } from 'vue';
import type { RemoteFsEntry } from '@/api/deploy';

/** 表格交互 Hook 参数接口 */
export interface UseTableInteractionOptions {
  tableAreaRef: Ref<HTMLElement | undefined>;
  getEntries: () => RemoteFsEntry[];
  getSelectedCount: () => number;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onRowContextMenu: (entry: RemoteFsEntry, event: MouseEvent) => void;
}

/**
 * 管理表格容器键盘快捷键、Shift 选区拦截、空白区域点击与右键定位。
 * @param options 交互配置选项
 * @returns 鼠标与键盘事件处理器
 */
export function useTableInteraction(options: UseTableInteractionOptions) {
  const {
    tableAreaRef,
    getEntries,
    getSelectedCount,
    onSelectAll,
    onClearSelection,
    onRowContextMenu,
  } = options;

  /**
   * 表格区域键盘快捷键监听：Cmd/Ctrl+A 全选与 ESC 清空
   */
  const handleKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      onSelectAll();
    } else if (event.key === 'Escape') {
      if (getSelectedCount() > 0) {
        event.preventDefault();
        event.stopPropagation();
        onClearSelection();
      }
    }
  };

  /**
   * 拦截鼠标按下事件：按住 Shift 连续多选时阻止浏览器默认文本选区行为，避免出现蓝色杂色块
   */
  const handleMouseDown = (event: MouseEvent) => {
    if (event.shiftKey) {
      event.preventDefault();
      tableAreaRef.value?.focus();
    }
  };

  /**
   * 空白区域点击清空选区
   */
  const handleAreaClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (
      target &&
      !target.closest('.vxe-body--row') &&
      !target.closest('.interactive-th') &&
      !target.closest('.action-capsule-btn')
    ) {
      onClearSelection();
    }
  };

  /**
   * 表格区域原生上下文菜单拦截：智能定位点击行并触发右键事件
   */
  const handleAreaContextMenu = (event: MouseEvent) => {
    event?.preventDefault?.();
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const rowEl = target.closest('.vxe-body--row');
    if (!rowEl) return;

    const entries = getEntries();
    // 1. 优先通过 rowid 属性精准定位
    const rowId = rowEl.getAttribute('rowid');
    let matched = entries.find((e: RemoteFsEntry) => String(e.name) === rowId);

    // 2. 兜底：通过在 tbody 中的行索引定位
    if (!matched && rowEl.parentElement) {
      const trList = Array.from(rowEl.parentElement.querySelectorAll('.vxe-body--row'));
      const index = trList.indexOf(rowEl);
      if (index >= 0 && index < entries.length) {
        matched = entries[index];
      }
    }

    if (matched) {
      onRowContextMenu(matched, event);
    }
  };

  return {
    handleKeyDown,
    handleMouseDown,
    handleAreaClick,
    handleAreaContextMenu,
  };
}
