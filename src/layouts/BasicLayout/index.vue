<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { isTauri } from '@/utils/env';
import { detectPlatform } from '@/utils/platformDetect';
import { useTheme } from '@/hooks/useTheme';
import { useNavigation } from './hooks/useNavigation';
import SettingsDrawer from '@/components/SettingsDrawer/index.vue';
import LayoutHeader from './components/LayoutHeader.vue';
import LayoutSider from './components/LayoutSider.vue';
import AboutModal from '@/components/AboutModal/index.vue';

defineOptions({ name: 'BasicLayout' });

/** 侧边栏折叠状态 */
const collapsed = ref(false);

/** 平台设置抽屉可见性 */
const openDrawer = ref(false);

/** 关于雨燕弹窗可见性 */
const showAboutModal = ref(false);

let unlistenMenuAbout: (() => void) | undefined;

const { primaryColor } = useTheme();
const { routeLoading } = useNavigation();

/** 平台检测 */
const platformInfo = detectPlatform();
const isMac = computed(() => platformInfo.platform === 'darwin');
const isWin = computed(() => platformInfo.platform === 'windows');
const isTauriClient = computed(() => isTauri());

/**
 * 主题色计算属性，用于将 Vue 响应式主题色输出为 CSS 变量
 */
const themeColors = computed(() => ({
  primary: primaryColor.value,
  primaryLight: primaryColor.value + '1a', // 10% 透明度
  primaryLighter: primaryColor.value + '0f', // 6% 透明度
  primaryHover: primaryColor.value + '14', // 8% 透明度
  primaryShadow: primaryColor.value + '26', // 15% 透明度
  primaryShadowLight: primaryColor.value + '14', // 8% 透明度
}));

/**
 * 显示关于雨燕弹窗的回调（全局事件驱动）
 */
const handleShowAboutModal = () => {
  showAboutModal.value = true;
};

onMounted(() => {
  window.addEventListener('show-about-modal', handleShowAboutModal);

  // 监听 macOS 顶部系统菜单"关于雨燕"点击事件
  if (isTauri()) {
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('menu-about', () => {
        showAboutModal.value = true;
      }).then((unlisten) => {
        unlistenMenuAbout = unlisten;
      });
    });
  }
});

onUnmounted(() => {
  window.removeEventListener('show-about-modal', handleShowAboutModal);
  if (unlistenMenuAbout) {
    unlistenMenuAbout();
  }
});
</script>

<template>
  <a-layout 
    :class="{ 
      'is-tauri-client': isTauriClient,
      'is-tauri-mac': isTauriClient && isMac,
      'is-tauri-win': isTauriClient && isWin
    }" 
    style="height: 100vh; overflow: hidden"
    :style="{
      '--theme-primary': themeColors.primary,
      '--theme-primary-light': themeColors.primaryLight,
      '--theme-primary-lighter': themeColors.primaryLighter,
      '--theme-primary-hover': themeColors.primaryHover,
      '--theme-primary-shadow': themeColors.primaryShadow,
      '--theme-primary-shadow-light': themeColors.primaryShadowLight
    }"
  >
    <!-- 侧边栏子组件 -->
    <LayoutSider v-model:collapsed="collapsed" />
    
    <a-layout>
      <!-- 头部子组件 -->
      <LayoutHeader 
        :isTauriClient="isTauriClient" 
        @openSettings="openDrawer = true" 
        @openAbout="showAboutModal = true"
      />
      
      <!-- 主体内容区域 -->
      <a-layout-content class="yuyan-layout-content">
        <div v-if="routeLoading" class="route-loading-mask">
          <a-spin tip="页面加载中" />
        </div>
        <router-view />
      </a-layout-content>
    </a-layout>
  </a-layout>

  <!-- 平台设置抽屉 -->
  <SettingsDrawer v-model:open="openDrawer" />
  
  <!-- 关于雨燕弹窗 -->
  <AboutModal v-model:open="showAboutModal" />
</template>

<style scoped lang="less">
@import './style.less';
</style>

<style lang="less">
/* 全局覆盖：定制 C4D 玻璃拟态风格 Tooltip 并防止折行 */
.header-tooltip {
  .ant-tooltip-inner {
    white-space: nowrap !important;
    word-break: keep-all !important;
    font-size: 12px !important;
    font-weight: 500 !important;
    padding: 6px 12px !important;
    border-radius: 8px !important;
    background: rgba(15, 23, 42, 0.85) !important;
    backdrop-filter: blur(10px) !important;
    -webkit-backdrop-filter: blur(10px) !important;
    border: 1px solid rgba(255, 255, 255, 0.15) !important;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2) !important;
    color: rgba(255, 255, 255, 0.95) !important;
  }

  .ant-tooltip-arrow-content {
    background-color: rgba(15, 23, 42, 0.85) !important;
  }
}
</style>
