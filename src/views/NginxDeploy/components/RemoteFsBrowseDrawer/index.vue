<script setup lang="ts">
import { computed } from 'vue';
import {
  ArrowUpOutlined,
  FileOutlined,
  FolderOpenOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons-vue';
import { YButton, YTable } from '@yss-ui/components/lite';
import type { DeployServer, RemoteFsEntry } from '@/api/deploy';
import RemoteFsExecPanel from './components/RemoteFsExecPanel/index.vue';
import RemoteFsFooter from './components/RemoteFsFooter/index.vue';
import RemoteFsPreviewModal from './components/RemoteFsPreviewModal/index.vue';
import RemoteFsToolbar from './components/RemoteFsToolbar/index.vue';
import { fsTableColumns } from './constant';
import { useFilePreview } from './hooks/useFilePreview';
import { useRemoteExec } from './hooks/useRemoteExec';
import { useRemoteFsBrowse } from './hooks/useRemoteFsBrowse';

defineOptions({ name: 'RemoteFsBrowseDrawer' });

interface RemoteFsBrowseDrawerProps {
  open: boolean;
  server?: DeployServer | null;
  initialPath?: string;
}

const props = defineProps<RemoteFsBrowseDrawerProps>();
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'selectPath', path: string): void;
}>();

const visible = computed({
  get: () => props.open,
  set: (val: boolean) => emit('update:open', val),
});

const {
  loading,
  roots,
  activeRoot,
  currentPath,
  isAtRoot,
  truncated,
  tableEntries,
  selectedEntry,
  breadcrumbs,
  fetchDirectory,
  navigateUp,
  drillDown,
  switchRoot,
  handleRowClick,
  handleRowDblClick,
  useCurrentPath,
} = useRemoteFsBrowse(props, emit);

const { previewVisible, previewLoading, previewFileName, previewContent, openPreview } = useFilePreview(props);
const { execPanelVisible, commandText, executing, execResult, toggleExecPanel, runCommand } = useRemoteExec(props);

const onCellClick = (params: any) => handleRowClick(params?.row as RemoteFsEntry);
const onCellDblClick = (params: any) => handleRowDblClick(params?.row as RemoteFsEntry, openPreview);
</script>

<template>
  <a-drawer
    v-model:open="visible"
    width="min(860px, 94vw)"
    class="remote-fs-drawer"
    :destroy-on-close="true"
    :z-index="1200"
    :root-style="{ zIndex: 1200 }"
  >
    <template #title>
      <div class="remote-fs-header-title">
        <span class="title-text">浏览远程目录</span>
        <span v-if="server" class="server-badge">{{ server.name }} ({{ server.host }})</span>
      </div>
    </template>

    <div class="remote-fs-shell">
      <div class="remote-fs-notice">
        <InfoCircleOutlined />
        <span>当前为受限作用域文件浏览模式，仅允许在配置的站点、Nginx 及部署根目录内上下钻访问。</span>
      </div>

      <RemoteFsToolbar
        v-model:current-path="currentPath"
        :is-at-root="isAtRoot"
        :loading="loading"
        :breadcrumbs="breadcrumbs"
        :roots="roots"
        :active-root="activeRoot"
        @navigate-up="navigateUp"
        @refresh="() => fetchDirectory(currentPath)"
        @use-path="useCurrentPath"
        @jump-breadcrumb="(p) => fetchDirectory(p)"
        @switch-root="switchRoot"
      />

      <div class="remote-fs-table-wrap">
        <a-alert v-if="truncated" type="warning" show-icon message="目录条目较多，已自动截断展示前 500 项" banner />
        <YTable
          :data="tableEntries"
          :columns="fsTableColumns"
          :loading="loading"
          :pageable="false"
          size="small"
          :max-height="420"
          :row-config="{ keyField: 'name', isCurrent: true }"
          @cell-click="onCellClick"
          @cell-dblclick="onCellDblClick"
        >
          <template #nameSlot="{ row }">
            <div class="fs-entry-row" :title="row.type === 'parent_dir' ? '双击返回上一级' : row.type === 'directory' ? '双击进入目录' : '双击预览文件'">
              <ArrowUpOutlined v-if="row.type === 'parent_dir'" class="entry-icon is-parent" />
              <FolderOpenOutlined v-else-if="row.type === 'directory'" class="entry-icon is-dir" />
              <FileOutlined v-else class="entry-icon is-file" />
              <span class="entry-name" :class="{ 'is-parent': row.type === 'parent_dir' }">{{ row.name }}</span>
            </div>
          </template>
          <template #actionSlot="{ row }">
            <YButton v-if="row.type === 'directory'" type="link" size="small" @click.stop="drillDown(row.name)">进入</YButton>
            <YButton v-else-if="row.type === 'parent_dir'" type="link" size="small" @click.stop="navigateUp">返回</YButton>
            <YButton v-else type="link" size="small" @click.stop="openPreview(row)">预览</YButton>
          </template>
        </YTable>
      </div>

      <RemoteFsExecPanel
        v-if="execPanelVisible"
        v-model:command-text="commandText"
        :executing="executing"
        :exec-result="execResult"
        @run="() => runCommand(currentPath)"
      />

      <RemoteFsFooter
        :selected-entry="selectedEntry"
        :total-count="tableEntries.length"
        :exec-panel-visible="execPanelVisible"
        @toggle-exec="toggleExecPanel"
        @close="visible = false"
      />
    </div>
  </a-drawer>

  <RemoteFsPreviewModal
    v-model:open="previewVisible"
    :loading="previewLoading"
    :file-name="previewFileName"
    :content="previewContent"
  />
</template>

<style scoped lang="less">
@import './style.less';
</style>
