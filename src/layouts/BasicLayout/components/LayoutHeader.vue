<script setup lang="ts">
import { useAuth } from '@/composables/useAuth';
import UpdateCapsule from '@/components/UpdateCapsule/index.vue';
// import NoticeCapsule from '@/components/NoticeCapsule/index.vue';
import { useAppUpdate } from '@/components/UpdateCapsule/hooks/useAppUpdate';
import { useTheme } from '@/hooks/useTheme';
import AiIntegrationTrigger from '@/components/AiIntegrationDrawer/components/AiIntegrationTrigger.vue';
import ThemePaintIcon from './LayoutHeader/components/ThemePaintIcon.vue';
import {
  UserOutlined,
  LogoutOutlined,
  LoginOutlined,
  SyncOutlined,
  CloudDownloadOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons-vue';
import { useDataSync } from '../hooks/useDataSync';

defineOptions({ name: 'LayoutHeader' });

defineProps<{
  /** 是否是 Tauri 客户端 */
  isTauriClient: boolean;
}>();

const emit = defineEmits<{
  /** 触发打开 AI 控制中心抽屉 */
  (e: 'open-ai-integration'): void;
  /** 触发打开平台设置抽屉 */
  (e: 'openSettings'): void;
  /** 触发打开登录弹窗 */
  (e: 'openLogin'): void;
  /** 触发打开关于雨燕弹窗 */
  (e: 'openAbout'): void;
}>();

const { isLoggedIn, userName, userAvatar, logout, authLoading } = useAuth();
const { isDark } = useTheme();
const { syncing, confirmSyncData } = useDataSync();
const { hasUpdate, handleCheckUpdateClick } = useAppUpdate();

/** 退出当前登录账号。 */
const handleLogout = async () => {
  await logout();
};
</script>

<template>
  <a-layout-header class="yuyan-layout-header" :class="{ 'is-dark': isDark }">
    <div class="yuyan-layout-header-left" :class="{ 'has-notice': !isTauriClient }">
      <UpdateCapsule v-if="isTauriClient && hasUpdate" />
      <!-- <NoticeCapsule v-if="!isTauriClient" /> -->
    </div>

    <div v-if="isTauriClient" class="yuyan-layout-header-drag" data-tauri-drag-region />

    <div class="yuyan-layout-header-right">
      <a-tooltip v-if="isTauriClient" title="刷新当前账号配置" overlayClassName="header-tooltip">
        <a-button type="text" :loading="syncing" class="header-action-btn btn-sync" @click="confirmSyncData">
          <template #icon>
            <SyncOutlined class="action-icon" />
          </template>
        </a-button>
      </a-tooltip>

      <a-tooltip v-if="isTauriClient" title="AI 集成" overlayClassName="header-tooltip">
        <AiIntegrationTrigger @open="emit('open-ai-integration')" />
      </a-tooltip>

      <a-tooltip title="平台设置" overlayClassName="header-tooltip">
        <a-button type="text" class="header-action-btn btn-settings" @click="$emit('openSettings')">
          <template #icon>
            <ThemePaintIcon class="action-icon" />
          </template>
        </a-button>
      </a-tooltip>

      <div class="user-section">
        <template v-if="authLoading">
          <div class="user-loading-skeleton">
            <a-skeleton-input active size="small" style="width: 120px; height: 32px" />
          </div>
        </template>

        <template v-else-if="isLoggedIn">
          <a-dropdown placement="bottomRight">
            <div class="user-dropdown-trigger">
              <a-avatar :src="userAvatar" :alt="userName" :size="28" class="user-avatar">
                {{ userName.charAt(0).toUpperCase() }}
              </a-avatar>
              <span class="user-name">{{ userName }}</span>
            </div>

            <template #overlay>
              <a-menu>
                <a-menu-item v-if="isTauriClient" key="check-update" @click="handleCheckUpdateClick">
                  <template #icon>
                    <CloudDownloadOutlined />
                  </template>
                  检查更新
                </a-menu-item>

                <a-menu-item v-if="isTauriClient" key="about" @click="$emit('openAbout')">
                  <template #icon>
                    <InfoCircleOutlined />
                  </template>
                  关于雨燕
                </a-menu-item>

                <a-menu-divider />

                <a-menu-item key="profile" disabled>
                  <template #icon>
                    <UserOutlined />
                  </template>
                  用户资料
                </a-menu-item>

                <a-menu-divider />

                <a-menu-item key="logout" class="logout-menu-item" @click="handleLogout">
                  <template #icon>
                    <LogoutOutlined />
                  </template>
                  退出登录
                </a-menu-item>
              </a-menu>
            </template>
          </a-dropdown>
        </template>

        <template v-else>
          <a-button type="primary" class="login-button" @click="$emit('openLogin')">
            <template #icon>
              <LoginOutlined />
            </template>
            登录
          </a-button>
        </template>
      </div>
    </div>
  </a-layout-header>
</template>

<style scoped lang="less">
@import './LayoutHeader/style.less';
</style>
