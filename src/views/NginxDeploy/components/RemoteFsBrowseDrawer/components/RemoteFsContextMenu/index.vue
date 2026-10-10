<script setup lang="ts">
import { computed, ref, toRef } from 'vue';
import {
  ArrowUpOutlined,
  CloudDownloadOutlined,
  CopyOutlined,
  DownloadOutlined,
  EyeOutlined,
  FolderOpenOutlined,
} from '@ant-design/icons-vue';
import type { RemoteFsEntry } from '@/api/deploy';
import { getContextMenuItems, getBatchContextMenuItems, type RemoteFsContextAction } from './constant';
import { useContextMenuDom } from './hooks/useContextMenuDom';

defineOptions({ name: 'RemoteFsContextMenu' });

interface RemoteFsContextMenuProps {
  visible: boolean;
  x: number;
  y: number;
  entry: RemoteFsEntry | null;
  selectedEntries?: RemoteFsEntry[];
  formattedSize?: string;
}

const props = defineProps<RemoteFsContextMenuProps>();
const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void;
  (e: 'action', action: RemoteFsContextAction, entry: RemoteFsEntry): void;
}>();

const menuRef = ref<HTMLElement | null>(null);

/** 图标组件映射字典。 */
const iconComponents: Record<string, any> = {
  ArrowUpOutlined,
  CloudDownloadOutlined,
  CopyOutlined,
  DownloadOutlined,
  EyeOutlined,
  FolderOpenOutlined,
};

/** 是否处于多选批量操作态。 */
const isBatchMode = computed(() => (props.selectedEntries?.length || 0) > 1);

/** 当前条目的有效操作项（单选或批量）。 */
const menuItems = computed(() =>
  isBatchMode.value
    ? getBatchContextMenuItems(props.selectedEntries || [], props.formattedSize)
    : getContextMenuItems(props.entry, props.formattedSize)
);

/** 抽离 DOM 定位、捕获阶段 ESC 退出栈与外部点击防穿透逻辑 */
const { menuStyle } = useContextMenuDom({
  menuRef,
  visible: toRef(props, 'visible'),
  x: toRef(props, 'x'),
  y: toRef(props, 'y'),
  onClose: () => emit('update:visible', false),
});

/** 触发操作并关闭菜单。 */
const handleItemClick = (action: RemoteFsContextAction) => {
  if (!props.entry) return;
  emit('action', action, props.entry);
  emit('update:visible', false);
};
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible && entry"
      ref="menuRef"
      class="remote-fs-context-menu"
      :style="menuStyle"
      @contextmenu.prevent
    >
      <div v-if="isBatchMode" class="menu-header-info is-batch">
        <span class="entry-name-label">已选择 {{ selectedEntries?.length }} 个项目</span>
        <span class="entry-badge-tag">批量</span>
      </div>
      <div v-else class="menu-header-info">
        <span class="entry-name-label" :title="entry.name">{{ entry.name }}</span>
        <span class="entry-badge-tag">{{ entry.type === 'directory' ? '文件夹' : '文件' }}</span>
      </div>
      <ul class="menu-list">
        <li
          v-for="item in menuItems"
          :key="item.key"
          class="menu-item"
          :class="{ 'is-download': item.key === 'download' }"
          @click="handleItemClick(item.key)"
        >
          <span class="item-icon">
            <component :is="iconComponents[item.iconName]" />
          </span>
          <div class="item-content">
            <div class="item-main-row">
              <span class="item-text">{{ item.label }}</span>
              <span v-if="item.subLabel" class="item-sub-label">{{ item.subLabel }}</span>
            </div>
            <div v-if="item.hint" class="item-hint-text">{{ item.hint }}</div>
          </div>
        </li>
      </ul>
    </div>
  </Teleport>
</template>

<style scoped lang="less">
@import './style.less';
</style>
