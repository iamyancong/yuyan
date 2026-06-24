<template>
  <a-layout style="height: 100vh; overflow: hidden">
    <a-layout-sider :theme="menuTheme" collapsible v-model:collapsed="collapsed">
      <div class="brand" @click="goHome">
        <div class="brand-logo"><LogoSwift :size="24" /></div>
        <div class="brand-name" v-show="!collapsed">雨燕平台</div>
      </div>
      <a-menu :theme="menuTheme" mode="inline" :selectedKeys="selectedKeys" @click="onMenuClick">
        <a-menu-item v-for="item in menuItems" :key="item.key">
          <template #icon>
            <component :is="item.icon" />
          </template>
          {{ item.label }}
        </a-menu-item>
      </a-menu>
    </a-layout-sider>
    <a-layout>
      <a-layout-header class="yuyan-layout-header">
        <div class="yuyan-layout-header-left">
          <!-- 左侧区域 -->
        </div>
        <div class="yuyan-layout-header-right">
          <!-- 用户头像和登录按钮 -->
          <div class="user-section">
            <template v-if="authLoading">
              <!-- 认证状态加载中，显示骨架屏 -->
              <div class="user-loading-skeleton">
                <a-skeleton-input active size="small" style="width: 120px; height: 32px; margin-right: 8px" />
              </div>
            </template>
            <template v-else-if="isLoggedIn">
              <a-dropdown placement="bottomRight">
                <div class="user-dropdown-trigger">
                  <a-avatar :src="userAvatar" :alt="userName" size="small" class="user-avatar">
                    {{ userName.charAt(0).toUpperCase() }}
                  </a-avatar>
                  <span class="user-name">{{ userName }}</span>
                </div>
                <template #overlay>
                  <a-menu>
                    <a-menu-item key="profile" disabled>
                      <template #icon>
                        <UserOutlined />
                      </template>
                      用户资料
                    </a-menu-item>
                    <a-menu-divider />
                    <a-menu-item key="logout" @click="handleLogout">
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
              <a-button type="primary" @click="showLoginModal = true" class="login-button">
                <template #icon>
                  <LoginOutlined />
                </template>
                登录
              </a-button>
            </template>
          </div>

          <!-- 数据同步 (仅在桌面端显示) -->
          <a-tooltip title="同步测试环境数据到本地" v-if="isTauriClient">
            <a-button type="text" :loading="syncing" @click="confirmSyncData">
              <template #icon>
                <SyncOutlined class="action-icon" />
              </template>
            </a-button>
          </a-tooltip>

          <!-- 平台设置 -->
          <a-tooltip title="平台设置">
            <a-button type="text" @click="openDrawer = true">
              <template #icon>
                <BgColorsOutlined class="action-icon" />
              </template>
            </a-button>
          </a-tooltip>
        </div>
      </a-layout-header>
      <a-layout-content class="yuyan-layout-content">
        <div v-if="routeLoading" class="route-loading-mask">
          <a-spin tip="页面加载中" />
        </div>
        <router-view />
      </a-layout-content>
    </a-layout>
  </a-layout>

  <SettingsDrawer v-model:open="openDrawer" />
  <LoginModal v-model:visible="showLoginModal" @login-success="handleLoginSuccess" />
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, nextTick } from 'vue';
import { NavigationFailureType, isNavigationFailure, useRoute, useRouter } from 'vue-router';
import { routes } from '@/router';
import { useTheme } from '@/hooks/useTheme';
import { useAuth } from '@/composables/useAuth';
import SettingsDrawer from '@/components/SettingsDrawer.vue';
import LoginModal from '@/components/LoginModal.vue';
import LogoSwift from '@/components/LogoSwift.vue';
import { 
  BgColorsOutlined, 
  AppstoreOutlined, 
  CloudServerOutlined, 
  ProjectOutlined, 
  UserOutlined, 
  LogoutOutlined, 
  LoginOutlined,
  SyncOutlined
} from '@ant-design/icons-vue';
import { isTauri } from '@/utils/env';
import { backupDbFromServer, restoreDbToLocal } from '@/api/deploy';
import { message, Modal } from 'ant-design-vue';

const collapsed = ref(false);
const route = useRoute();
const router = useRouter();

const { menuTheme, primaryColor } = useTheme();
const { isLoggedIn, currentUser, userName, userAvatar, logout, authLoading, checkAuth } = useAuth();

// 桌面端标识
const isTauriClient = computed(() => isTauri());
// 同步状态
const syncing = ref(false);

/**
 * 弹出同步确认弹窗，若用户确认则从测试环境拉取 SQLite 数据库并覆盖写入本地
 */
const confirmSyncData = () => {
  Modal.confirm({
    title: '同步测试环境数据到本地',
    content: '确定要拉取测试环境（http://192.168.164.27:3100）的最新数据库并覆盖本地吗？此操作不可逆，本地现有的所有配置和服务器数据将被完全覆盖。',
    okText: '确认同步',
    cancelText: '取消',
    onOk: async () => {
      syncing.value = true;
      try {
        message.loading({ content: '正在从测试环境下载数据...', key: 'db-sync', duration: 0 });
        // 1. 下载测试环境数据库二进制数据
        const dbData = await backupDbFromServer('http://192.168.164.27:3100');
        
        message.loading({ content: '正在写入本地数据库并重新挂载...', key: 'db-sync', duration: 0 });
        // 2. 还原数据覆盖本地 SQLite 文件
        const result = await restoreDbToLocal(dbData);
        
        if (result && result.success) {
          message.success({ content: '数据同步成功！正在刷新页面...', key: 'db-sync', duration: 2 });
          setTimeout(() => {
            window.location.reload();
          }, 1500);
        } else {
          throw new Error(result?.message || '未知错误');
        }
      } catch (error: any) {
        console.error('数据同步失败:', error);
        message.error({ 
          content: `数据同步失败: ${error.message || '网络连接超时，请确保测试环境服务运行正常'}`, 
          key: 'db-sync', 
          duration: 5 
        });
      } finally {
        syncing.value = false;
      }
    }
  });
};

// 登录模态框状态
const showLoginModal = ref(false);
const routeLoading = ref(false);
let navigationSequence = 0;

// 监听全局登录事件
const handleShowLoginModal = () => {
  showLoginModal.value = true;
};

const selectedKeys = computed(() => [route.path]);
const title = computed(() => (route.meta?.title as string) || '概览');

// 主题色计算属性
const themeColors = computed(() => ({
  primary: primaryColor.value,
  primaryLight: primaryColor.value + '1a', // 10% 透明度
  primaryLighter: primaryColor.value + '0f', // 6% 透明度
  primaryHover: primaryColor.value + '14', // 8% 透明度
  primaryShadow: primaryColor.value + '26', // 15% 透明度
  primaryShadowLight: primaryColor.value + '14', // 8% 透明度
}));

// 基于路由生成菜单（读取根路由的 children，并以 meta.title 为文案）
const rootRoute = routes.find((r) => r.path === '/');
const rawMenuRoutes = (rootRoute?.children || []).filter((r) => !(r as any).redirect && (r.meta as any)?.title);
const menuItems = computed(() =>
  rawMenuRoutes.map((r) => ({
    key: r.path as string,
    label: (r.meta as any).title as string,
    icon: getMenuIcon(r.name as string),
  }))
);

/**
 * 输出开发环境下的路由切换错误，避免生产环境干扰用户。
 * @param error 路由切换错误
 */
const handleNavigationError = (error: unknown) => {
  if (isNavigationFailure(error, NavigationFailureType.cancelled) || isNavigationFailure(error, NavigationFailureType.duplicated)) {
    return;
  }

  if (import.meta.env.DEV) {
    console.warn('路由切换失败', error);
  }
};

/**
 * 切换到指定页面；冷缓存命中时展示加载反馈。
 * @param path 目标路由路径
 */
const navigateToPath = async (path: string) => {
  if (!path || path === route.path) return;

  const currentNavigation = ++navigationSequence;
  routeLoading.value = true;
  try {
    await router.push(path);
  } finally {
    if (currentNavigation === navigationSequence) {
      routeLoading.value = false;
    }
  }
};

const onMenuClick = ({ key }: { key: string }) => {
  void navigateToPath(key).catch(handleNavigationError);
};

onMounted(() => {
  window.addEventListener('show-login-modal', handleShowLoginModal);
});

onUnmounted(() => {
  window.removeEventListener('show-login-modal', handleShowLoginModal);
});

// 自定义菜单图标映射
const getMenuIcon = (routeName: string) => {
  const iconMap: Record<string, any> = {
    Scaffold: AppstoreOutlined,
    ProjectList: ProjectOutlined,
    OpsProjectList: ProjectOutlined,
    NginxDeploy: CloudServerOutlined,
  };
  return iconMap[routeName] || AppstoreOutlined;
};

const openDrawer = ref(false);

// 用户认证相关函数
const handleLogout = async () => {
  await logout();
};

const handleLoginSuccess = async () => {
  // 登录成功后，确保认证状态正确更新
  console.log('用户登录成功，刷新认证状态');

  // 等待一小段时间确保状态已完全更新
  await nextTick();

  // 如果认证状态仍然不正确，手动刷新一次
  if (!isLoggedIn.value || !currentUser.value) {
    console.log('认证状态未正确更新，手动刷新');
    await checkAuth();
  }

  // 再次等待确保UI完全更新
  await nextTick();
};

const goHome = () => {
  void navigateToPath('/scaffold').catch(handleNavigationError);
};
</script>

<style scoped lang="less">
.yuyan-layout-content {
  position: relative;
  margin: 14px;
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.route-loading-mask {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 96px;
  background: rgba(245, 247, 250, 0.56);
  backdrop-filter: blur(2px);
}

.yuyan-layout-header {
  background: var(--bg-color-container);
  padding: 0 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  --theme-primary: v-bind(primaryColor);
  --theme-primary-light: v-bind('themeColors.primaryLight');
  --theme-primary-lighter: v-bind('themeColors.primaryLighter');
  --theme-primary-hover: v-bind('themeColors.primaryHover');
  --theme-primary-shadow: v-bind('themeColors.primaryShadow');
  --theme-primary-shadow-light: v-bind('themeColors.primaryShadowLight');
}

:deep(.ant-layout-header) {
  height: 56px;
}
.brand {
  height: 56px;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 0 12px;
  border-bottom: 1px solid var(--border-color-split);
  margin-bottom: 4px;
}
.brand-logo {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  background: rgba(255, 255, 255, 0.18);
  color: #0f172a;
}
.brand-name {
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--text-color);
}
.ant-layout-sider-dark .brand-logo {
  background: rgba(255, 255, 255, 0.22);
  color: #0b1220;
}
.ant-layout-sider-dark .brand-name {
  color: rgba(255, 255, 255, 0.95);
}
.ant-layout-sider-light .brand-logo {
  background: rgba(0, 0, 0, 0.06);
  color: #111827;
}
.ant-layout-sider-light .brand-name {
  color: var(--text-color);
}
.toolbar {
  display: flex;
  align-items: center;
}
.action-icon {
  font-size: 16px;
  color: #595959;
}

.yuyan-layout-header-right {
  display: flex;
  align-items: center;
}

.ant-layout-header {
  line-height: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
/* 用户区域样式 */
.user-section {
  display: flex;
  align-items: center;
  margin-right: 16px;

  .user-dropdown-trigger {
    display: flex;
    align-items: center;
    gap: 8px;
    border-radius: 24px;
    cursor: pointer;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    position: relative;
    min-height: 40px;
    padding: 0px 12px;

    &::before {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 24px;
      background: transparent;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      z-index: -1;
    }

    &:hover {
      &::before {
        background: var(--theme-primary-hover);
        backdrop-filter: blur(8px);
      }
      transform: translateY(-1px);
      box-shadow: 0 4px 16px var(--theme-primary-shadow), 0 2px 8px var(--theme-primary-shadow-light);

      .user-avatar {
        border-color: var(--theme-primary);
        transform: scale(1.05);
        box-shadow: 0 2px 8px var(--theme-primary-light);
      }

      .user-name {
        color: var(--theme-primary);
        font-weight: 600;
      }
    }

    .user-name {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-color);
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      transition: color 0.3s ease;
    }

    .user-avatar {
      width: 32px;
      height: 32px;
      border: 2px solid rgba(0, 0, 0, 0.1);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      border-radius: 50%;
      flex-shrink: 0;

      // 默认头像边框颜色使用主题色，更淡一点
      border-color: color-mix(in srgb, var(--theme-primary), transparent 80%);
    }
  }

  .login-button {
    border-radius: 20px;
    height: 32px;
    padding: 0 16px;
    font-weight: 500;
    box-shadow: 0 2px 8px rgba(24, 144, 255, 0.2);
    transition: all 0.3s ease;

    &:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(24, 144, 255, 0.3);
    }
  }
}

/* 深色主题适配 */
.ant-layout-sider-dark {
  .user-section {
    .user-dropdown-trigger {
      &:hover {
        &::before {
          background: var(--theme-primary-lighter);
          backdrop-filter: blur(8px);
        }
        transform: translateY(-1px);
        box-shadow: 0 4px 16px var(--theme-primary-light), 0 2px 8px var(--theme-primary-hover);

        .user-name {
          color: var(--theme-primary);
        }

        .user-avatar {
          border-color: var(--theme-primary);
          transform: scale(1.05);
          box-shadow: 0 2px 8px var(--theme-primary-hover);
        }
      }

      .user-name {
        color: #e6e6e6;
      }

      .user-avatar {
        border-color: rgba(255, 255, 255, 0.2);
      }
    }
  }
}

/* 深色主题下的整体适配 */
@media (prefers-color-scheme: dark) {
  .yuyan-layout-header {
    background: var(--bg-color-container);

    .user-section {
      .user-dropdown-trigger {
        &:hover {
          &::before {
            background: var(--theme-primary-lighter);
            backdrop-filter: blur(8px);
          }
          transform: translateY(-1px);
          box-shadow: 0 4px 16px var(--theme-primary-light), 0 2px 8px var(--theme-primary-hover);

          .user-name {
            color: var(--theme-primary);
          }

          .user-avatar {
            border-color: var(--theme-primary);
            transform: scale(1.05);
            box-shadow: 0 2px 8px var(--theme-primary-hover);
          }
        }

        .user-name {
          color: #e6e6e6;
        }

        .user-avatar {
          border-color: rgba(255, 255, 255, 0.2);
        }
      }

      .login-button {
        background: linear-gradient(135deg, var(--theme-primary) 0%, color-mix(in srgb, var(--theme-primary), #000 20%) 100%);
        border-color: var(--theme-primary);

        &:hover {
          background: linear-gradient(
            135deg,
            color-mix(in srgb, var(--theme-primary), #fff 5%) 0%,
            color-mix(in srgb, var(--theme-primary), #000 25%) 100%
          );
          border-color: color-mix(in srgb, var(--theme-primary), #fff 5%);
          transform: translateY(-1px);
        }
      }
    }
  }
}

/* 用户区域骨架屏样式 */
.user-loading-skeleton {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 24px;
  min-height: 40px;

  :deep(.ant-skeleton-input) {
    border-radius: 16px !important;
  }
}

/* 移动端适配 */
@media (max-width: 768px) {
  .user-section {
    .user-dropdown-trigger {
      .user-name {
        display: none;
      }
    }

    .user-loading-skeleton {
      padding: 4px 8px;

      :deep(.ant-skeleton-input) {
        width: 80px !important;
      }
    }
  }
}
</style>
