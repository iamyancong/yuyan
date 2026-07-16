<script setup lang="ts">
import { computed } from 'vue';
import LogoSwift from '@/components/LogoSwift.vue';
import { useTheme } from '@/hooks/useTheme';
import { useNavigation } from '../../hooks/useNavigation';
import { isTauri } from '@/utils/env';
import { detectPlatform } from '@/utils/platformDetect';

defineOptions({ name: 'LayoutSider' });

defineProps<{
  /** 侧边栏折叠状态 */
  collapsed: boolean;
}>();

defineEmits<{
  /** 触发更新折叠状态 */
  (e: 'update:collapsed', value: boolean): void;
}>();

const { menuTheme } = useTheme();
const { selectedKeys, menuItems, onMenuClick, goHome } = useNavigation();

// 平台检测
const isTauriClient = isTauri();
const platformInfo = detectPlatform();
const isMac = platformInfo.platform === 'darwin';
const isTauriMac = computed(() => isTauriClient && isMac);
</script>

<template>
  <a-layout-sider 
    :theme="menuTheme" 
    collapsible 
    :collapsed="collapsed" 
    @update:collapsed="$emit('update:collapsed', $event)"
    :width="190"
  >
    <div class="brand" :class="{ 'is-tauri-mac-brand': isTauriMac }" data-tauri-drag-region>
      <div class="brand-content" @click="goHome">
        <div class="brand-logo">
          <LogoSwift :size="24" />
        </div>
        <div class="brand-name" v-show="!collapsed">雨燕平台</div>
      </div>
    </div>
    
    <a-menu 
      :theme="menuTheme" 
      mode="inline" 
      :inlineIndent="12"
      :selectedKeys="selectedKeys" 
      @click="onMenuClick"
    >
      <a-menu-item v-for="item in menuItems" :key="item.key">
        <template #icon>
          <component :is="item.icon" />
        </template>
        {{ item.label }}
      </a-menu-item>
    </a-menu>
  </a-layout-sider>
</template>

<style scoped lang="less">
@import './style.less';
</style>
