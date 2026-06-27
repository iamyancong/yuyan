<template>
  <a-layout :class="{ 'is-tauri-client': isTauriClient }" style="height: 100vh; overflow: hidden">
    <a-layout-sider :theme="menuTheme" collapsible v-model:collapsed="collapsed">
      <div class="brand" data-tauri-drag-region>
        <div class="brand-content" @click="goHome">
          <div class="brand-logo"><LogoSwift :size="24" /></div>
          <div class="brand-name" v-show="!collapsed">雨燕平台</div>
        </div>
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
          <!-- 发现新版本更新提示胶囊 (Codex 风格) -->
          <div 
            v-if="hasUpdate && isTauriClient"
            class="update-capsule"
            :class="`status-${updateState.status}`"
            @click="handleCapsuleClick"
          >
            <template v-if="updateState.status === 'idle'">
              <CloudDownloadOutlined class="capsule-icon" />
              <span>发现新版本 v{{ latestVersion }}</span>
            </template>
            <template v-else-if="updateState.status === 'downloading'">
              <LoadingOutlined class="capsule-icon" v-if="updatePercent === 100" />
              <SyncOutlined spin class="capsule-icon" v-else />
              <span class="progress-bar-bg" :style="{ width: updatePercent + '%' }"></span>
              <span class="progress-text">正在下载 {{ updatePercent }}%</span>
            </template>
            <template v-else-if="updateState.status === 'completed'">
              <LoadingOutlined class="capsule-icon" />
              <span>正在安装...</span>
            </template>
            <template v-else-if="updateState.status === 'error'">
              <span style="margin-right: 4px;">⚠️</span>
              <span>下载失败，点击重试</span>
            </template>
          </div>
        </div>
        <div class="yuyan-layout-header-drag" data-tauri-drag-region></div>
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
                    <a-menu-item key="check-update" @click="handleCheckUpdateClick" v-if="isTauriClient">
                      <template #icon>
                        <CloudDownloadOutlined />
                      </template>
                      检查更新
                    </a-menu-item>
                    <a-menu-divider v-if="isTauriClient" />
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
  SyncOutlined,
  CloudDownloadOutlined,
  InfoCircleOutlined,
  LoadingOutlined
} from '@ant-design/icons-vue';
import { isTauri } from '@/utils/env';
import { backupDbFromServer, restoreDbToLocal, downloadAndInstallAppUpdate, getAppUpdateStatus, checkAppUpdateFromServer } from '@/api/deploy';
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

// ============ 自动更新检测相关逻辑 (Codex 风格) ============
const hasUpdate = ref(false);
const checkingUpdate = ref(false);
const currentAppVersion = ref('1.0.0');
const latestVersion = ref('');
const updateLogs = ref('');
const downloadUrl = ref('');
const isMacUser = computed(() => /macintosh|mac os x/i.test(navigator.userAgent));

// 下载进度与状态
const updateState = ref({
  status: 'idle', // 'idle' | 'downloading' | 'completed' | 'error'
  progress: 0,
  error: null as string | null
});
const updatePercent = computed(() => updateState.value.progress);

/**
 * 初始化本地应用版本号
 */
const initLocalVersion = async () => {
  // 本地开发模拟测试保护：如果在 currentAppVersion 处写死了非 '1.0.0' 的低版本，则保留当前设定的模拟版本
  if (currentAppVersion.value !== '1.0.0') {
    return;
  }
  if (isTauriClient.value) {
    try {
      const { getVersion } = await import('@tauri-apps/api/app');
      currentAppVersion.value = await getVersion();
    } catch (e) {
      console.warn('获取本地版本号失败，使用默认配置:', e);
    }
  }
};

/**
 * 语义化版本号对比 (Semantic Versioning)
 * 判断 remote 是否比 local 版本新
 */
const isNewerVersion = (local: string, remote: string) => {
  const l = local.replace(/^v/, '');
  const r = remote.replace(/^v/, '');
  
  if (l === r) return false;
  
  const [lMain, lPre] = l.split('-');
  const [rMain, rPre] = r.split('-');
  
  const lParts = lMain.split('.').map(Number);
  const rParts = rMain.split('.').map(Number);
  
  for (let i = 0; i < Math.max(lParts.length, rParts.length); i++) {
    const lNum = lParts[i] || 0;
    const rNum = rParts[i] || 0;
    if (rNum > lNum) return true;
    if (lNum > rNum) return false;
  }
  
  // 预发布版本 (Prerelease) 判定逻辑
  if (rPre && !lPre) return false;
  if (!rPre && lPre) return true;
  if (rPre && lPre && rPre !== lPre) return true;
  
  return false;
};

/**
 * 执行 GitHub Releases 更新检测
 * @param manual 是否为手动点击检测
 */
const checkAppUpdate = async (manual = false) => {
  if (checkingUpdate.value) return;
  checkingUpdate.value = true;
  
  try {
    await initLocalVersion();
    
    // 调用内网部署服务器进行代理更新检测（Token 由服务端环境变量 GITHUB_TOKEN 统一管理）
    const platform = isMacUser.value ? 'darwin' : 'win32';
    const res = await checkAppUpdateFromServer(currentAppVersion.value, platform);
    
    if (res && res.hasUpdate && res.downloadUrl) {
      hasUpdate.value = true;
      latestVersion.value = res.latestVersion || '';
      updateLogs.value = res.updateLogs || '无更新内容描述。';
      downloadUrl.value = res.downloadUrl; // 内网服务器中转代理绝对下载直链
      
      // 如果本地客户端 Node 已经有下载任务在跑，直接激活进度轮询
      const statusRes = await getAppUpdateStatus();
      if (statusRes && statusRes.status === 'downloading') {
        updateState.value.status = statusRes.status;
        updateState.value.progress = statusRes.progress;
        startProgressPolling();
      }
    } else {
      hasUpdate.value = false;
      if (manual) {
        message.success(res?.message || '当前已是最新版本！');
      }
    }
  } catch (error: any) {
    console.error('内网代理更新检测失败:', error);
    if (manual) {
      message.error(`检查更新失败: ${error.message || '连接内网服务器异常'}`);
    }
  } finally {
    checkingUpdate.value = false;
  }
};

let progressInterval: any = null;

const startProgressPolling = () => {
  if (progressInterval) clearInterval(progressInterval);
  progressInterval = setInterval(async () => {
    try {
      const res = await getAppUpdateStatus();
      updateState.value.status = res.status;
      updateState.value.progress = res.progress;
      updateState.value.error = res.error;
      
      if (res.status === 'completed') {
        message.success('新版本下载成功，正在拉起安装包进行覆盖安装...');
        if (progressInterval) {
          clearInterval(progressInterval);
          progressInterval = null;
        }
      } else if (res.status === 'error') {
        message.error(res.error || '更新下载失败');
        if (progressInterval) {
          clearInterval(progressInterval);
          progressInterval = null;
        }
      }
    } catch (e) {
      console.error('[Update] 轮询下载进度失败:', e);
    }
  }, 500);
};

const handleCheckUpdateClick = () => {
  void checkAppUpdate(true);
};

const handleCapsuleClick = () => {
  if (updateState.value.status === 'downloading' || updateState.value.status === 'completed') {
    return;
  }
  
  Modal.confirm({
    title: `发现新版本 v${latestVersion.value}，确认开始下载？`,
    content: `点击确认后，程序将通过本地后端在后台进行安装包下载。您可以在 Header 左侧看到下载进度。下载完成后，将自动拉起安装包，届时请按照安装向导覆盖安装。`,
    okText: '确认更新',
    cancelText: '稍后提醒',
    onOk: async () => {
      const filename = isMacUser.value ? `yuyan-${latestVersion.value}.dmg` : `yuyan-${latestVersion.value}.exe`;
      
      try {
        updateState.value.status = 'downloading';
        updateState.value.progress = 0;
        updateState.value.error = null;
        
        // downloadUrl 已经是免密的内网中转直链，Token 由服务端统一管理
        const res = await downloadAndInstallAppUpdate(downloadUrl.value, filename);
        if (res && res.success) {
          startProgressPolling();
        } else {
          throw new Error(res?.message || '无法发起下载请求');
        }
      } catch (e: any) {
        updateState.value.status = 'error';
        updateState.value.error = e.message || '网络连接失败';
        message.error(`无法发起更新下载: ${e.message || '连接本地后端异常'}`);
      }
    }
  });
};
// ============================================

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
  
  // 开启桌面端后台静默更新检测
  if (isTauriClient.value) {
    setTimeout(() => {
      void checkAppUpdate(false);
    }, 2000);
  }
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

.yuyan-layout-header-drag {
  flex: 1;
  height: 100%;
  cursor: default;
  -webkit-user-select: none;
  user-select: none;
}

:deep(.ant-layout-header) {
  height: 56px;
}

.brand {
  height: 56px;
  display: flex;
  align-items: center;
  padding: 0 16px;
  border-bottom: 1px solid var(--border-color-split);
  margin-bottom: 4px;
  transition: all 0.2s ease;

  .brand-content {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    width: 100%;
    height: 100%;
  }
}

.is-tauri-client {
  .brand {
    padding-top: 28px;
    height: 84px;
  }
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

/* ==========================================
 * 桌面端侧边栏高级定制（Light / Dark）
 * ========================================== */

// 1. 亮色（Light）侧边栏进化
:deep(.ant-layout-sider-light) {
  background: linear-gradient(180deg, #fbfcfd 0%, #f3f5f8 100%) !important;
  border-right: 1px solid #e2e8f0;

  .brand {
    border-bottom: 1px solid #e8edf3;
  }

  .brand-logo {
    background: rgba(0, 0, 0, 0.05);
    color: var(--primary-color);
  }

  .brand-name {
    color: #1e293b;
  }

  .ant-menu-light {
    background: transparent !important;
    border-inline-end: none !important;
  }

  // 菜单项卡片悬浮化
  .ant-menu-item {
    margin: 4px 10px !important;
    width: calc(100% - 20px) !important;
    border-radius: 8px !important;
    height: 40px !important;
    line-height: 40px !important;
    color: #475569 !important;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1) !important;

    &:hover {
      background: rgba(15, 23, 42, 0.04) !important;
      color: var(--primary-color) !important;
    }

    &.ant-menu-item-selected {
      background: var(--primary-color-light) !important;
      color: var(--primary-color) !important;
      font-weight: 600 !important;

      &::after {
        display: none !important;
      }
    }
  }

  // 折叠触发器
  .ant-layout-sider-trigger {
    background: #f1f5f9 !important;
    border-top: 1px solid #e2e8f0;
    border-right: 1px solid #e2e8f0;
    color: #64748b !important;
    &:hover {
      background: #e2e8f0 !important;
      color: var(--primary-color) !important;
    }
  }
}

// 2. 暗色（Dark）侧边栏重构
:deep(.ant-layout-sider-dark) {
  background: #0f172a !important; /* 经典深蓝色 */
  border-right: 1px solid #1e293b;

  .brand {
    border-bottom: 1px solid #1e293b;
  }

  .brand-logo {
    background: rgba(255, 255, 255, 0.15);
    color: #ffffff;
  }

  .brand-name {
    color: rgba(255, 255, 255, 0.95);
  }

  .ant-menu-dark {
    background: transparent !important;
  }

  // 菜单项卡片悬浮化
  .ant-menu-item {
    margin: 4px 10px !important;
    width: calc(100% - 20px) !important;
    border-radius: 8px !important;
    height: 40px !important;
    line-height: 40px !important;
    color: #94a3b8 !important;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1) !important;

    &:hover {
      background: rgba(255, 255, 255, 0.06) !important;
      color: #ffffff !important;
    }

    &.ant-menu-item-selected {
      background: var(--primary-color) !important;
      color: #ffffff !important;
      font-weight: 600 !important;
      box-shadow: 0 4px 12px var(--theme-primary-shadow);

      &::after {
        display: none !important;
      }
    }
  }

  // 折叠触发器
  .ant-layout-sider-trigger {
    background: #0f172a !important;
    border-top: 1px solid #1e293b;
    color: #94a3b8 !important;
    &:hover {
      background: #1e293b !important;
      color: #ffffff !important;
    }
  }
}

// 侧边栏折叠时的水平居中适配
:deep(.ant-layout-sider-collapsed) {
  .brand {
    padding-left: 0 !important;
    padding-right: 0 !important;
  }
  .brand-content {
    justify-content: center !important;
  }

  .ant-menu-item {
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    padding: 0 !important;
    text-align: center !important;
    line-height: normal !important;

    .ant-menu-item-icon {
      margin: 0 !important;
      line-height: 1 !important;
    }

    .ant-menu-title-content {
      opacity: 0 !important;
      width: 0 !important;
      display: inline-block !important;
      margin: 0 !important;
      overflow: hidden !important;
    }
  }
}

// 发现新版本动态状态胶囊 (Codex 风格)
.update-capsule {
  display: inline-flex;
  align-items: center;
  position: relative;
  height: 28px;
  padding: 0 12px;
  border-radius: 14px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  overflow: hidden;
  user-select: none;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 2px 6px rgba(24, 144, 255, 0.15);

  .capsule-icon {
    margin-right: 6px;
    font-size: 13px;
    position: relative;
    z-index: 2;
  }

  span {
    position: relative;
    z-index: 2;
  }

  /* 默认发现更新状态（蓝色胶囊） */
  &.status-idle {
    background: #1890ff;
    color: #ffffff;
    &:hover {
      background: #40a9ff;
      box-shadow: 0 4px 10px rgba(24, 144, 255, 0.3);
      transform: translateY(-1px);
    }
    &:active {
      transform: translateY(0);
    }
  }

  /* 正在下载状态（展示进度条） */
  &.status-downloading {
    background: rgba(24, 144, 255, 0.08);
    border: 1px solid rgba(24, 144, 255, 0.24);
    color: #1890ff;
    cursor: default;

    .progress-bar-bg {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      background: rgba(24, 144, 255, 0.2);
      z-index: 1;
      transition: width 0.1s linear;
    }
    .progress-text {
      font-weight: bold;
    }
  }

  /* 正在安装状态 */
  &.status-completed {
    background: #52c41a;
    color: #ffffff;
    cursor: default;
    box-shadow: 0 2px 6px rgba(82, 196, 26, 0.15);
  }

  /* 错误状态 */
  &.status-error {
    background: #ff4d4f;
    color: #ffffff;
    box-shadow: 0 2px 6px rgba(255, 77, 79, 0.15);
    &:hover {
      background: #ff7875;
      transform: translateY(-1px);
    }
  }
}
</style>
