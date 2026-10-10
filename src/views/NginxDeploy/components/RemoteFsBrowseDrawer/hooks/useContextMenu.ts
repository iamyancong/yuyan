import { ref } from 'vue';
import type { RemoteFsEntry } from '@/api/deploy';
import type { RemoteFsContextAction } from '../components/RemoteFsContextMenu/constant';

/** 右键菜单动作处理器配置。 */
export interface UseContextMenuOptions {
  onDownload: (entry: RemoteFsEntry, selectedList?: RemoteFsEntry[]) => void;
  onDrillDown: (name: string) => void;
  onPreview: (entry: RemoteFsEntry) => void;
  onCopyPath: (path: string) => void;
  onCopyMultiplePaths?: (paths: string[]) => void;
  onNavigateUp: () => void;
  onSelectExclusive?: (entry: RemoteFsEntry) => void;
}

/**
 * 远程文件系统右键菜单交互 Hook。
 * 负责追踪右键点击目标、视口坐标、菜单显隐、多选感知与动作分发。
 * @param options 动作回调字典
 */
export function useContextMenu(options?: UseContextMenuOptions) {
  const contextMenuVisible = ref(false);
  const contextMenuPosition = ref({ x: 0, y: 0 });
  const contextMenuTarget = ref<RemoteFsEntry | null>(null);
  const contextMenuSelectedEntries = ref<RemoteFsEntry[]>([]);

  /**
   * 打开上下文右键菜单。
   * @param entry 目标文件或目录项
   * @param event 鼠标事件
   * @param currentSelectedEntries 当前外部的多选条目数组
   */
  const openContextMenu = (
    entry: RemoteFsEntry,
    event: MouseEvent,
    currentSelectedEntries: RemoteFsEntry[] = []
  ) => {
    const isAlreadySelected = currentSelectedEntries.some((e) => e.path === entry.path);

    if (isAlreadySelected && entry.type !== 'parent_dir') {
      // 1. 右键命中已有选区（无论单选还是多选）：保持既有选区不丢失
      contextMenuTarget.value = entry;
      contextMenuSelectedEntries.value = currentSelectedEntries;
    } else {
      // 2. 右键命中未选项或父目录：重置为当前项单选
      contextMenuTarget.value = entry;
      contextMenuSelectedEntries.value = entry.type === 'parent_dir' ? [] : [entry];
      options?.onSelectExclusive?.(entry);
    }

    contextMenuPosition.value = { x: event.clientX, y: event.clientY };
    contextMenuVisible.value = true;
  };

  /** 关闭上下文右键菜单。 */
  const closeContextMenu = () => {
    contextMenuVisible.value = false;
  };

  /**
   * 分发执行上下文菜单操作。
   * @param action 菜单操作标识
   * @param entry 目标条目
   */
  const handleContextMenuAction = (action: RemoteFsContextAction, entry: RemoteFsEntry) => {
    if (!options) return;
    const isBatch = contextMenuSelectedEntries.value.length > 1;

    const actionHandlers: Record<RemoteFsContextAction, () => void> = {
      download: () => {
        if (isBatch) {
          options.onDownload(entry, contextMenuSelectedEntries.value);
        } else {
          options.onDownload(entry, [entry]);
        }
      },
      drillDown: () => options.onDrillDown(entry.name),
      preview: () => options.onPreview(entry),
      copyPath: () => {
        if (isBatch && options.onCopyMultiplePaths) {
          options.onCopyMultiplePaths(
            contextMenuSelectedEntries.value.map((e) => e.path || '').filter(Boolean)
          );
        } else {
          entry.path && options.onCopyPath(entry.path);
        }
      },
      navigateUp: () => options.onNavigateUp(),
    };

    actionHandlers[action]?.();
  };

  return {
    contextMenuVisible,
    contextMenuPosition,
    contextMenuTarget,
    contextMenuSelectedEntries,
    openContextMenu,
    closeContextMenu,
    handleContextMenuAction,
  };
}
