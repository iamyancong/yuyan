<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, type CSSProperties } from 'vue';
import {
  ArrowUpOutlined,
  CloudDownloadOutlined,
  CopyOutlined,
  DownloadOutlined,
  EyeOutlined,
  FolderOpenOutlined,
} from '@ant-design/icons-vue';
import type { RemoteFsEntry } from '@/api/deploy';
import { getContextMenuItems, type RemoteFsContextAction } from './constant';

defineOptions({ name: 'RemoteFsContextMenu' });

interface RemoteFsContextMenuProps {
  visible: boolean;
  x: number;
  y: number;
  entry: RemoteFsEntry | null;
}

const props = defineProps<RemoteFsContextMenuProps>();
const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void;
  (e: 'action', action: RemoteFsContextAction, entry: RemoteFsEntry): void;
}>();

const menuRef = ref<HTMLElement | null>(null);

/** 图标组件映射。 */
const iconComponents: Record<string, any> = {
  ArrowUpOutlined,
  CloudDownloadOutlined,
  CopyOutlined,
  DownloadOutlined,
  EyeOutlined,
  FolderOpenOutlined,
};

/** 当前条目的有效操作项。 */
const menuItems = computed(() => getContextMenuItems(props.entry));

/**
 * 计算菜单智能定位样式，防止贴底或靠右超出视口边界。
 */
const menuStyle = computed<CSSProperties>(() => {
  const menuWidth = 180;
  const menuHeight = 160;
  const padding = 12;

  let left = props.x;
  let top = props.y;

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

/** 触发操作并关闭菜单。 */
const handleItemClick = (action: RemoteFsContextAction) => {
  if (!props.entry) return;
  emit('action', action, props.entry);
  emit('update:visible', false);
};

/** 点击菜单外部或按下 ESC 键自动关闭。 */
const handleGlobalPointerDown = (event: MouseEvent) => {
  if (event.button === 2) return;
  if (props.visible && menuRef.value && !menuRef.value.contains(event.target as Node)) {
    emit('update:visible', false);
  }
};

const handleKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && props.visible) {
    emit('update:visible', false);
  }
};

onMounted(() => {
  window.addEventListener('pointerdown', handleGlobalPointerDown, true);
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('scroll', () => emit('update:visible', false), true);
});

onUnmounted(() => {
  window.removeEventListener('pointerdown', handleGlobalPointerDown, true);
  window.removeEventListener('keydown', handleKeyDown);
  window.removeEventListener('scroll', () => emit('update:visible', false), true);
});
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
      <div class="menu-header-info">
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
          <span class="item-text">{{ item.label }}</span>
        </li>
      </ul>
    </div>
  </Teleport>
</template>

<style scoped lang="less">
@import './style.less';
</style>
