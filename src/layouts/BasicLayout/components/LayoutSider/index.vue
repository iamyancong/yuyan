<script setup lang="ts">
import { computed } from 'vue';
import { MenuFoldOutlined, MenuUnfoldOutlined } from '@ant-design/icons-vue';
import LogoSwift from '@/components/LogoSwift.vue';
import { useTheme } from '@/hooks/useTheme';
import { useNavigation } from '../../hooks/useNavigation';
import { isTauri } from '@/utils/env';
import { detectPlatform } from '@/utils/platformDetect';

defineOptions({ name: 'LayoutSider' });

const props = defineProps<{
  /** 侧边栏折叠状态 */
  collapsed: boolean;
}>();

const emit = defineEmits<{
  /** 触发更新折叠状态 */
  (e: 'update:collapsed', value: boolean): void;
}>();

const { menuTheme } = useTheme();
const { selectedKeys, menuItems, onMenuClick, goHome } = useNavigation();

/** 当前是否运行在 Tauri 客户端。 */
const isTauriClient = isTauri();
/** 当前操作系统信息。 */
const platformInfo = detectPlatform();
/** 当前是否为 macOS。 */
const isMac = platformInfo.platform === 'darwin';
/** 是否需要为 macOS 原生标题栏预留拖拽区。 */
const isTauriMac = computed(() => isTauriClient && isMac);

/** 切换侧边栏的展开与收起状态。 */
const handleToggle = () => {
  emit('update:collapsed', !props.collapsed);
};
</script>

<template>
  <a-layout-sider
    :theme="menuTheme"
    collapsible
    :collapsed="collapsed"
    :collapsedWidth="76"
    :trigger="null"
    :width="190"
  >
    <div class="brand" :class="{ 'is-tauri-mac-brand': isTauriMac }" data-tauri-drag-region>
      <button class="brand-content" type="button" aria-label="返回雨燕平台首页" @click="goHome">
        <div class="brand-logo">
          <span class="logo-aura" aria-hidden="true" />
          <span class="logo-glass" aria-hidden="true" />
          <LogoSwift :size="30" />
        </div>
        <span class="brand-copy" :aria-hidden="collapsed">
          <strong class="brand-name">雨燕平台</strong>
          <span class="brand-signature"><i aria-hidden="true" /> YUYAN · OPS</span>
        </span>
      </button>
    </div>

    <div class="nav-caption" :aria-hidden="collapsed">
      <span class="nav-caption-text">工作空间</span>
    </div>

    <a-menu
      :theme="menuTheme"
      mode="inline"
      :inlineIndent="12"
      :selectedKeys="selectedKeys"
      @click="onMenuClick"
    >
      <a-menu-item
        v-for="item in menuItems"
        :key="item.key"
        :aria-current="selectedKeys.includes(item.key) ? 'page' : undefined"
      >
        <template #icon>
          <component :is="item.icon" />
        </template>
        <span class="menu-label">{{ item.label }}</span>
      </a-menu-item>
    </a-menu>

    <div class="sider-footer">
      <button
        class="sider-collapse-control"
        type="button"
        :title="collapsed ? '展开侧栏' : '收起侧栏'"
        :aria-label="collapsed ? '展开侧栏' : '收起侧栏'"
        :aria-expanded="!collapsed"
        @click="handleToggle"
      >
        <span class="collapse-icon" aria-hidden="true">
          <MenuUnfoldOutlined v-if="collapsed" />
          <MenuFoldOutlined v-else />
        </span>
        <span class="collapse-label" :aria-hidden="collapsed">收起侧栏</span>
        <span class="collapse-signal" aria-hidden="true"><i /><i /></span>
      </button>
    </div>
  </a-layout-sider>
</template>

<style scoped lang="less">
@import './style.less';
</style>
