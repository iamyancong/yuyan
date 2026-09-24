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
  dirCount, fileCount, breadcrumbs, toggleSort, fetchDirectory, navigateUp,
  drillDown, handleRowClick, handleRowDblClick, copyPath, useCurrentPath,
} = useRemoteFsBrowse(props, emit);

const { previewVisible, previewLoading, previewFileName, previewContent, openPreview } = useFilePreview(props);
const { execPanelVisible, commandText, executing, execResult, toggleExecPanel, runCommand } = useRemoteExec(props);
const { downloadRemoteFsEntry } = useRemoteFsDownload();
const { contextMenuVisible, contextMenuPosition, contextMenuTarget, openContextMenu, handleContextMenuAction } =
  useContextMenu({
    onDownload: (entry) => void downloadRemoteFsEntry(props.server, entry),
    onDrillDown: (name) => drillDown(name),
    onPreview: (entry) => void openPreview(entry),
    onCopyPath: (p) => copyPath(p),
    onNavigateUp: navigateUp,
  });
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

    <div class="remote-fs-shell">
      <RemoteFsToolbar
        v-model:path-input="pathInput"
        v-model:show-hidden="showHidden"
        v-model:filter-keyword="filterKeyword"
        :current-path="currentPath"
        :is-at-root="isAtRoot"
        :loading="loading"
        :breadcrumbs="breadcrumbs"
        @navigate-up="navigateUp"
        @refresh="() => fetchDirectory(currentPath)"
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
        @row-click="handleRowClick"
        @row-dblclick="(entry: RemoteFsEntry) => handleRowDblClick(entry, openPreview)"
        @row-context-menu="openContextMenu"
        @navigate-up="navigateUp"
        @drill-down="drillDown"
        @preview="openPreview"
        @toggle-sort="toggleSort"
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
    @action="handleContextMenuAction"
  />
</template>

<style scoped lang="less">
@import './style.less';
</style>
