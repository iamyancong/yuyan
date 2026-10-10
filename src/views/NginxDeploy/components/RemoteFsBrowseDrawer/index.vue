<script setup lang="ts">
import { computed } from 'vue';
import type { DeployServer, RemoteFsEntry } from '@/api/deploy';
import RemoteFsHeader from './components/RemoteFsHeader/index.vue';
import RemoteFsToolbar from './components/RemoteFsToolbar/index.vue';
import RemoteFsEntryTable from './components/RemoteFsEntryTable/index.vue';
import RemoteFsExecPanel from './components/RemoteFsExecPanel/index.vue';
import RemoteFsFooter from './components/RemoteFsFooter/index.vue';
import RemoteFsPreviewModal from './components/RemoteFsPreviewModal/index.vue';
import RemoteFsContextMenu from './components/RemoteFsContextMenu/index.vue';
import type { RemoteFsContextAction } from './components/RemoteFsContextMenu/constant';
import { useFilePreview } from './hooks/useFilePreview';
import { useRemoteExec } from './hooks/useRemoteExec';
import { useRemoteFsBrowse } from './hooks/useRemoteFsBrowse';
import { useContextMenu } from './hooks/useContextMenu';
import { useRemoteFsDownload } from './hooks/useRemoteFsDownload';
import { useSelectionSize } from './hooks/useSelectionSize';

defineOptions({ name: 'RemoteFsBrowseDrawer' });

interface RemoteFsBrowseDrawerProps {
  open: boolean;
  server?: DeployServer | null;
  initialPath?: string;
}

const props = defineProps<RemoteFsBrowseDrawerProps>();
const emit = defineEmits<{ (e: 'update:open', val: boolean): void; (e: 'selectPath', path: string): void }>();
const visible = computed({ get: () => props.open, set: (val: boolean) => emit('update:open', val) });

const {
  loading, showHidden, filterKeyword, sortField, sortAsc, roots,
  currentPath, pathInput, isAtRoot, truncated, tableEntries, selectedEntry,
  selectedEntries, selectedPathSet, dirCount, fileCount, breadcrumbs,
  toggleSort, fetchDirectory, navigateUp, drillDown, handleRowClick,
  handleRowDblClick, selectAllEntries, clearSelection, setSelectedEntries,
  copyPath, copyMultiplePaths, useCurrentPath,
} = useRemoteFsBrowse(props, emit);

const serverIdRef = computed(() => props.server?.id);
const {
  sizeStatus,
  formattedSize,
  contextMenuSizeLabel,
  sizeError,
  sizeWarning,
  isLargePackage,
  clearSizeCache,
} = useSelectionSize(serverIdRef, selectedEntries, currentPath);

const { previewVisible, previewLoading, previewFileName, previewContent, openPreview } = useFilePreview(props);
const { execPanelVisible, commandText, executing, execResult, toggleExecPanel, runCommand } = useRemoteExec(props);
const { downloadRemoteFsEntries } = useRemoteFsDownload();
const {
  contextMenuVisible,
  contextMenuPosition,
  contextMenuTarget,
  contextMenuSelectedEntries,
  openContextMenu,
  handleContextMenuAction,
} = useContextMenu({
  onDownload: (_entry, selectedList) => void downloadRemoteFsEntries(props.server, selectedList || [_entry]),
  onDrillDown: (name) => drillDown(name),
  onPreview: (entry) => void openPreview(entry),
  onCopyPath: (p) => copyPath(p),
  onCopyMultiplePaths: (paths) => void copyMultiplePaths(paths),
  onNavigateUp: navigateUp,
  onSelectExclusive: (entry) => setSelectedEntries([entry]),
});

/**
 * 抽屉外壳层级按键监听：当焦点在表格外部但处于抽屉内部时，保障次高优先级按 ESC 清空选区而不误关抽屉。
 */
const handleShellKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    if (contextMenuVisible.value) return;
    if (selectedEntries.value.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      clearSelection();
    }
  }
};
</script>

<template>
  <a-drawer
    v-model:open="visible"
    width="min(1080px, 96vw)"
    class="remote-fs-drawer"
    :destroy-on-close="true"
    :z-index="1200"
    :root-style="{ zIndex: 1200 }"
  >
    <template #title>
      <RemoteFsHeader
        :server="server"
        :roots="roots"
        :current-path="currentPath"
        @select-root="(rootPath) => fetchDirectory(rootPath)"
      />
    </template>

    <div class="remote-fs-shell" @keydown="handleShellKeyDown">
      <RemoteFsToolbar
        v-model:path-input="pathInput"
        v-model:show-hidden="showHidden"
        v-model:filter-keyword="filterKeyword"
        :current-path="currentPath"
        :is-at-root="isAtRoot"
        :loading="loading"
        :breadcrumbs="breadcrumbs"
        @navigate-up="navigateUp"
        @refresh="() => { clearSizeCache(); fetchDirectory(currentPath); }"
        @navigate-to-path="() => fetchDirectory(pathInput)"
        @copy-path="copyPath"
        @jump-breadcrumb="(p) => fetchDirectory(p)"
      />

      <RemoteFsEntryTable
        :entries="tableEntries"
        :loading="loading"
        :truncated="truncated"
        :dir-count="dirCount"
        :file-count="fileCount"
        :sort-field="sortField"
        :sort-asc="sortAsc"
        :selected-count="selectedEntries.length"
        :selected-path-set="selectedPathSet"
        :size-status="sizeStatus"
        :formatted-size="formattedSize"
        :size-error="sizeError"
        :size-warning="sizeWarning"
        :is-large-package="isLargePackage"
        @row-click="handleRowClick"
        @row-dblclick="(entry: RemoteFsEntry) => handleRowDblClick(entry, openPreview)"
        @row-context-menu="(entry: RemoteFsEntry, event: MouseEvent) => openContextMenu(entry, event, selectedEntries)"
        @navigate-up="navigateUp"
        @drill-down="drillDown"
        @preview="openPreview"
        @toggle-sort="toggleSort"
        @select-all="selectAllEntries"
        @clear-selection="clearSelection"
      />

      <RemoteFsExecPanel
        v-if="execPanelVisible"
        v-model:command-text="commandText"
        :working-directory="currentPath"
        :executing="executing"
        :exec-result="execResult"
        @run="() => runCommand(currentPath)"
        @close="toggleExecPanel"
      />

      <RemoteFsFooter
        :current-path="currentPath"
        :selected-entry="selectedEntry"
        :selected-entries="selectedEntries"
        :exec-panel-visible="execPanelVisible"
        :loading="loading"
        @toggle-exec="toggleExecPanel"
        @close="visible = false"
        @use-path="useCurrentPath"
      />
    </div>
  </a-drawer>

  <RemoteFsPreviewModal
    v-model:open="previewVisible"
    :loading="previewLoading"
    :file-name="previewFileName"
    :content="previewContent"
  />

  <RemoteFsContextMenu
    v-model:visible="contextMenuVisible"
    :x="contextMenuPosition.x"
    :y="contextMenuPosition.y"
    :entry="contextMenuTarget"
    :selected-entries="contextMenuSelectedEntries"
    :formatted-size="contextMenuSizeLabel"
    @action="handleContextMenuAction"
  />
</template>

<style scoped lang="less">
@import './style.less';
</style>
