import { ref } from 'vue';
import type { RemoteFsEntry } from '@/api/deploy';
import type { RemoteFsContextAction } from '../components/RemoteFsContextMenu/constant';

/** 右键菜单动作处理器配置。 */
export interface UseContextMenuOptions {
  onDownload: (entry: RemoteFsEntry) => void;
  onDrillDown: (name: string) => void;
  onPreview: (entry: RemoteFsEntry) => void;
  onCopyPath: (path: string) => void;
  onNavigateUp: () => void;
}

/**
 * 远程文件系统右键菜单交互 Hook。
 * 负责追踪右键点击目标、视口坐标、菜单显隐与动作分发。
 * @param options 动作回调字典
 */
export function useContextMenu(options?: UseContextMenuOptions) {
  const contextMenuVisible = ref(false);
  const contextMenuPosition = ref({ x: 0, y: 0 });
  const contextMenuTarget = ref<RemoteFsEntry | null>(null);

  /**
   * 打开上下文右键菜单。
   * @param entry 目标文件或目录项
   * @param event 鼠标事件
   */
  const openContextMenu = (entry: RemoteFsEntry, event: MouseEvent) => {
    contextMenuTarget.value = entry;
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
    const actionHandlers: Record<RemoteFsContextAction, () => void> = {
      download: () => options.onDownload(entry),
      drillDown: () => options.onDrillDown(entry.name),
      preview: () => options.onPreview(entry),
      copyPath: () => entry.path && options.onCopyPath(entry.path),
      navigateUp: () => options.onNavigateUp(),
    };
    actionHandlers[action]?.();
  };

  return {
    contextMenuVisible,
    contextMenuPosition,
    contextMenuTarget,
    openContextMenu,
    closeContextMenu,
    handleContextMenuAction,
  };
}
