<script setup lang="ts">
import { ref, onMounted, onUnmounted, nextTick, computed } from 'vue';
import { isTauri } from '@/utils/env';
import { detectPlatform } from '@/utils/platformDetect';
import { useTheme } from '@/hooks/useTheme';
import { useAuth } from '@/composables/useAuth';
import { useNavigation } from './hooks/useNavigation';
import SettingsDrawer from '@/components/SettingsDrawer/index.vue';
import AiIntegrationDrawer from '@/components/AiIntegrationDrawer/index.vue';
import LoginModal from '@/components/LoginModal.vue';
import LayoutHeader from './components/LayoutHeader.vue';
import LayoutSider from './components/LayoutSider/index.vue';
import AboutModal from '@/components/AboutModal/index.vue';
import AgentApprovalHost from '@/components/AgentApprovalHost/index.vue';

defineOptions({ name: 'BasicLayout' });

/** 侧边栏折叠状态 */
const collapsed = ref(false);

/** 登录模态框可见性 */
const showLoginModal = ref(false);

/** 平台设置抽屉可见性 */
const openDrawer = ref(false);

/** AI 控制中心抽屉可见性 */
const openAiDrawer = ref(false);

/** 关于雨燕弹窗可见性 */
const showAboutModal = ref(false);

let unlistenMenuAbout: (() => void) | undefined;

const { primaryColor } = useTheme();
const { isLoggedIn, currentUser, checkAuth } = useAuth();
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
 * 显示登录模态框的回调（全局事件驱动）
 */
const handleShowLoginModal = () => {
  showLoginModal.value = true;
};

/**
 * 显示关于雨燕弹窗的回调（全局事件驱动）
 */
const handleShowAboutModal = () => {
  showAboutModal.value = true;
};

/** 打开独立 AI 控制中心并确保平台设置抽屉关闭。 */
const handleOpenAiIntegration = () => {
  console.log('[BasicLayout] 打开 AI 控制中心抽屉');
  openDrawer.value = false;
  openAiDrawer.value = true;
};

/**
 * 登录成功后的回调函数，用于确保刷新全局用户状态与 UI
 */
const handleLoginSuccess = async () => {
  console.log('用户登录成功，刷新认证状态');
  await nextTick();
  
  if (!isLoggedIn.value || !currentUser.value) {
    console.log('认证状态未正确更新，手动刷新');
    await checkAuth();
  }
  
  await nextTick();
};

onMounted(() => {
  window.addEventListener('show-login-modal', handleShowLoginModal);
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
  window.removeEventListener('show-login-modal', handleShowLoginModal);
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
        @open-ai-integration="handleOpenAiIntegration"
        @openSettings="openDrawer = true" 
        @openLogin="showLoginModal = true" 
        @openAbout="showAboutModal = true"
      />
      
      <!-- 主体内容区域 -->
      <a-layout-content class="yuyan-layout-content" :aria-busy="routeLoading">
        <div v-if="routeLoading" class="route-loading-progress" role="progressbar" aria-label="页面切换中">
          <span />
        </div>
        <router-view v-slot="{ Component, route }">
          <KeepAlive :max="4">
            <component :is="Component" :key="String(route.name || route.path)" />
          </KeepAlive>
        </router-view>
      </a-layout-content>
    </a-layout>
  </a-layout>

  <!-- 平台设置抽屉 -->
  <SettingsDrawer v-model:open="openDrawer" />

  <!-- AI 控制中心抽屉 -->
  <AiIntegrationDrawer v-model:open="openAiDrawer" />
  
  <!-- 登录弹窗 -->
  <LoginModal v-model:visible="showLoginModal" @login-success="handleLoginSuccess" />
  
  <!-- 关于雨燕弹窗 -->
  <AboutModal v-model:open="showAboutModal" />

  <!-- 外部 Agent 的全局审批门禁 -->
  <AgentApprovalHost />
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
