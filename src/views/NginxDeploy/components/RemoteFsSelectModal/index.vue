<script setup lang="ts">
import { computed } from 'vue';
import { ArrowUpOutlined, FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons-vue';
import { YButton, YTable } from '@yss-ui/components/lite';
import type { DeployServer, RemoteFsEntry } from '@/api/deploy';
import { fsSelectTableColumns } from './constant';
import { useRemoteFsSelect } from './hooks/useRemoteFsSelect';

defineOptions({ name: 'RemoteFsSelectModal' });

interface RemoteFsSelectModalProps {
  open: boolean;
  server?: DeployServer | null;
  initialPath?: string;
}

const props = defineProps<RemoteFsSelectModalProps>();
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'select', path: string): void;
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
  selectedPath,
  isAtRoot,
  breadcrumbs,
  tableEntries,
  fetchDirectory,
  navigateUp,
  drillDown,
  switchRoot,
  handleRowClick,
  handleRowDblClick,
  confirmSelection,
} = useRemoteFsSelect(props, emit);

const onCellClick = (params: any) => handleRowClick(params?.row as RemoteFsEntry);
const onCellDblClick = (params: any) => handleRowDblClick(params?.row as RemoteFsEntry);
</script>

<template>
  <a-modal
    v-model:open="visible"
    width="680px"
    centered
    :destroy-on-close="true"
    :z-index="1100"
    wrap-class-name="remote-fs-select-modal-wrap"
    @cancel="emit('update:open', false)"
  >
    <template #title>
      <div class="select-header-title">
        <span class="title-main">选择服务器部署根目录</span>
        <span v-if="server" class="server-badge">{{ server.name }} ({{ server.host }})</span>
      </div>
    </template>

    <div class="remote-fs-select-shell">
      <div class="select-toolbar">
        <YButton size="small" :disabled="isAtRoot || loading" title="返回上一级目录" @click="navigateUp">
          <ArrowUpOutlined /> 上级
        </YButton>
        <a-select
          :value="activeRoot?.id"
          size="small"
          class="root-select"
          placeholder="切换受限作用域"
          @change="(val: any) => {
            const found = roots.find((r) => r.id === val);
            if (found) switchRoot(found);
          }"
        >
          <a-select-option v-for="item in roots" :key="item.id" :value="item.id">
            {{ item.label }}
          </a-select-option>
        </a-select>
        <div class="breadcrumbs-wrap">
          <template v-for="seg in breadcrumbs" :key="seg.path">
            <span class="crumb-sep">/</span>
            <span
              class="crumb-item"
              :class="{ 'is-active': seg.isLast }"
              :title="`跳转到 ${seg.path}`"
              @click="fetchDirectory(seg.path)"
            >
              {{ seg.name }}
            </span>
          </template>
        </div>
        <YButton size="small" :loading="loading" title="刷新目录" @click="() => fetchDirectory(currentPath)">
          <ReloadOutlined />
        </YButton>
      </div>

      <div class="select-table-wrap">
        <YTable
          :data="tableEntries"
          :columns="fsSelectTableColumns"
          :loading="loading"
          :pageable="false"
          size="small"
          :max-height="340"
          :row-config="{ keyField: 'name', isCurrent: true }"
          @cell-click="onCellClick"
          @cell-dblclick="onCellDblClick"
        >
          <template #nameSlot="{ row }">
            <div class="select-entry-row" :title="row.type === 'parent_dir' ? '双击返回上一级' : '双击进入目录，单击选中'">
              <ArrowUpOutlined v-if="row.type === 'parent_dir'" class="entry-icon is-parent" />
              <FolderOpenOutlined v-else class="entry-icon is-dir" />
              <span class="entry-name" :class="{ 'is-parent': row.type === 'parent_dir' }">{{ row.name }}</span>
            </div>
          </template>
          <template #actionSlot="{ row }">
            <YButton v-if="row.type === 'directory'" type="link" size="small" @click.stop="drillDown(row.name)">进入</YButton>
            <YButton v-else-if="row.type === 'parent_dir'" type="link" size="small" @click.stop="navigateUp">返回</YButton>
          </template>
        </YTable>
      </div>
    </div>

    <template #footer>
      <div class="select-modal-footer">
        <div class="footer-hint" :title="selectedPath || currentPath">
          <span>当前选定:</span>
          <span class="hint-path">{{ selectedPath || currentPath || '(未选择)' }}</span>
        </div>
        <div class="footer-actions">
          <YButton @click="emit('update:open', false)">取消</YButton>
          <YButton type="primary" :disabled="!selectedPath && !currentPath" @click="confirmSelection">
            确定使用此路径
          </YButton>
        </div>
      </div>
    </template>
  </a-modal>
</template>

<style scoped lang="less">
@import './style.less';
</style>
