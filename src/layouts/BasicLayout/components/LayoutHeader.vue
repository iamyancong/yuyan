<script setup lang="ts">
import { useAuth } from '@/composables/useAuth';
import UpdateCapsule from '@/components/UpdateCapsule/index.vue';
import { useAppUpdate } from '@/components/UpdateCapsule/hooks/useAppUpdate';
import {
  BgColorsOutlined,
  UserOutlined,
  LogoutOutlined,
  LoginOutlined,
  SyncOutlined,
  CloudDownloadOutlined,
  InfoCircleOutlined
} from '@ant-design/icons-vue';
import { useDataSync } from '../hooks/useDataSync';

defineOptions({ name: 'LayoutHeader' });

defineProps<{
  /** 是否是 Tauri 客户端 */
  isTauriClient: boolean;
}>();

defineEmits<{
  /** 触发打开平台设置抽屉 */
  (e: 'openSettings'): void;
  /** 触发打开登录弹窗 */
  (e: 'openLogin'): void;
  /** 触发打开关于雨燕弹窗 */
  (e: 'openAbout'): void;
}>();

const { isLoggedIn, userName, userAvatar, logout, authLoading } = useAuth();
const { syncing, confirmSyncData } = useDataSync();
const { handleCheckUpdateClick } = useAppUpdate();

/**
 * 处理退出登录逻辑
 */
const handleLogout = async () => {
  await logout();
};
</script>

<template>
  <a-layout-header class="yuyan-layout-header">
    <div class="yuyan-layout-header-left">
      <!-- 赛博玻璃拟态更新胶囊 -->
      <UpdateCapsule v-if="isTauriClient" />
    </div>
    
    <div class="yuyan-layout-header-drag" v-if="isTauriClient" data-tauri-drag-region></div>
    
    <div class="yuyan-layout-header-right">
      <!-- 数据同步 (仅在桌面端显示) -->
      <a-tooltip title="同步测试环境数据到本地" v-if="isTauriClient" overlayClassName="header-tooltip">
        <a-button type="text" :loading="syncing" @click="confirmSyncData" class="header-action-btn btn-sync">
          <template #icon>
            <SyncOutlined class="action-icon" />
          </template>
        </a-button>
      </a-tooltip>

      <!-- 平台设置 -->
      <a-tooltip title="平台设置" overlayClassName="header-tooltip">
        <a-button type="text" @click="$emit('openSettings')" class="header-action-btn btn-settings">
          <template #icon>
            <BgColorsOutlined class="action-icon" />
          </template>
        </a-button>
      </a-tooltip>

      <!-- 用户头像和登录按钮 -->
      <div class="user-section">
        <template v-if="authLoading">
          <!-- 认证状态加载中，显示骨架屏 -->
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
                <a-menu-item key="check-update" @click="handleCheckUpdateClick" v-if="isTauriClient">
                  <template #icon>
                    <CloudDownloadOutlined />
                  </template>
                  检查更新
                </a-menu-item>
                
                <a-menu-item key="about" @click="$emit('openAbout')" v-if="isTauriClient">
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
          <a-button type="primary" @click="$emit('openLogin')" class="login-button">
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
.yuyan-layout-header {
  background: var(--bg-color-container);
  padding: 0 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.yuyan-layout-header-left {
  display: flex;
  align-items: center;
  
  &:has(.notice-capsule) {
    flex: 1;
    margin-right: 24px;
  }
}

.yuyan-layout-header-drag {
  flex: 1;
  height: 100%;
  cursor: default;
  -webkit-user-select: none;
  user-select: none;
}

.yuyan-layout-header-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 刷新与设置按钮的 C4D 玻璃卡片样式 */
.header-action-btn {
  width: 34px;
  height: 34px;
  padding: 0 !important;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--glass-bg);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--glass-border);
  box-shadow: 
    0 4px 10px rgba(0, 0, 0, 0.03), 
    var(--glass-inset-shadow),
    inset 0 -1px 1px rgba(0, 0, 0, 0.02);
  transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
  cursor: pointer;
  position: relative;
  overflow: hidden;

  // 内部 icon
  .action-icon {
    font-size: 16px;
    color: var(--text-color-secondary);
    transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
  }

  // 炫彩光效扫过动画
  &::after {
    content: '';
    position: absolute;
    top: -50%;
    left: -150%;
    width: 200%;
    height: 200%;
    background: linear-gradient(
      45deg,
      transparent 45%,
      rgba(255, 255, 255, 0.4) 50%,
      transparent 55%
    );
    transform: rotate(-45deg);
    opacity: 0;
  }

  &:hover {
    transform: translateY(-2px) scale(1.05);
    background: linear-gradient(
      135deg, 
      color-mix(in srgb, var(--theme-primary), transparent 90%) 0%, 
      rgba(255, 255, 255, 0.7) 100%
    );
    border-color: color-mix(in srgb, var(--theme-primary), transparent 60%);
    box-shadow: 
      0 6px 16px var(--theme-primary-shadow),
      inset 0 1px 1px rgba(255, 255, 255, 0.9);

    .action-icon {
      color: var(--theme-primary);
      transform: scale(1.1);
    }

    &::after {
      opacity: 1;
      left: 150%;
      transition: all 0.7s cubic-bezier(0.25, 0.8, 0.25, 1);
    }
  }

  &:active {
    transform: translateY(0) scale(0.96);
    box-shadow: 
      0 2px 8px var(--theme-primary-shadow),
      inset 0 1px 2px rgba(0, 0, 0, 0.05);
  }

  // 刷新按钮旋转动画
  &.btn-sync:hover {
    .action-icon {
      animation: spin-around 0.8s cubic-bezier(0.4, 0, 0.2, 1);
    }
  }

  // 平台设置 icon 旋转微动效
  &.btn-settings:hover {
    .action-icon {
      transform: scale(1.1) rotate(45deg);
    }
  }
}

@keyframes spin-around {
  from { transform: rotate(0deg) scale(1.1); }
  to { transform: rotate(360deg) scale(1.1); }
}

/* 用户区域样式 */
.user-section {
  display: flex;
  align-items: center;

  .user-dropdown-trigger {
    display: flex;
    align-items: center;
    height: 34px; /* 固定高度，与刷新、设置按钮高度完美对齐 */
    gap: 6px;
    border-radius: 17px; /* 完美半圆圆角胶囊 */
    cursor: pointer;
    transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
    position: relative;
    padding: 0 10px 0 4px; /* 去除上下 padding，靠 align-items: center 精准居中对齐 */
    background: var(--glass-bg);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid var(--glass-border);
    box-shadow: 
      0 4px 10px rgba(0, 0, 0, 0.02),
      var(--glass-inset-shadow);

    .user-name {
      font-size: 13px;
      font-weight: 600;
      color: #334155;
      max-width: 100px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      transition: color 0.3s ease;
    }

    .user-avatar {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1.5px solid rgba(255, 255, 255, 0.6);
      background: linear-gradient(135deg, var(--theme-primary-light) 0%, rgba(255, 255, 255, 0.9) 100%);
      color: var(--theme-primary);
      font-weight: 700;
      font-size: 11px;
      transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
      border-radius: 50%;
      flex-shrink: 0;
      box-shadow: 
        0 2px 6px rgba(0, 0, 0, 0.05),
        inset 0 1px 1px rgba(255, 255, 255, 0.4);

      :deep(img) {
        border-radius: 50%;
        display: block;
        object-fit: cover;
      }
    }

    &:hover {
      transform: translateY(-2px);
      background: linear-gradient(
        135deg, 
        color-mix(in srgb, var(--theme-primary), transparent 90%) 0%, 
        rgba(255, 255, 255, 0.7) 100%
      );
      border-color: color-mix(in srgb, var(--theme-primary), transparent 60%);
      box-shadow: 
        0 8px 24px var(--theme-primary-shadow),
        inset 0 1px 1px rgba(255, 255, 255, 0.9);

      .user-name {
        color: var(--theme-primary);
      }

      .user-avatar {
        border-color: transparent;
        transform: scale(1.08) rotate(5deg);
        box-shadow: 
          0 0 0 2px color-mix(in srgb, var(--theme-primary), transparent 75%),
          0 0 14px color-mix(in srgb, var(--theme-primary), transparent 40%),
          0 4px 12px var(--theme-primary-shadow-light);
      }
    }
  }

  .login-button {
    border-radius: 16px;
    height: 32px;
    padding: 0 16px;
    font-weight: 600;
    font-size: 13px;
    background: linear-gradient(135deg, var(--theme-primary) 0%, color-mix(in srgb, var(--theme-primary), #000 10%) 100%);
    border: none;
    box-shadow: 0 4px 12px var(--theme-primary-shadow-light);
    transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);

    &:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 16px var(--theme-primary-shadow);
      background: linear-gradient(135deg, color-mix(in srgb, var(--theme-primary), #fff 10%) 0%, var(--theme-primary) 100%);
    }

    &:active {
      transform: translateY(0);
    }
  }

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
}

/* 深色主题下的整体适配 */
:global(html[data-theme="dark"]) {
  .header-action-btn {
    background: rgba(15, 23, 42, 0.35);
    border-color: rgba(255, 255, 255, 0.1);
    box-shadow: 
      0 4px 10px rgba(0, 0, 0, 0.2), 
      inset 0 1px 0 rgba(255, 255, 255, 0.08);

    .action-icon {
      color: #94a3b8;
    }

    &:hover {
      background: linear-gradient(
        135deg,
        color-mix(in srgb, var(--theme-primary), transparent 85%) 0%,
        rgba(15, 23, 42, 0.6) 100%
      );
      border-color: color-mix(in srgb, var(--theme-primary), transparent 40%);
      box-shadow: 
        0 6px 16px var(--theme-primary-shadow),
        inset 0 1px 0 rgba(255, 255, 255, 0.15);

      .action-icon {
        color: var(--theme-primary);
      }
    }
  }

  .user-section {
    .user-dropdown-trigger {
      background: rgba(15, 23, 42, 0.35);
      border-color: rgba(255, 255, 255, 0.1);
      box-shadow: 
        0 4px 10px rgba(0, 0, 0, 0.2), 
        inset 0 1px 0 rgba(255, 255, 255, 0.08);

      .user-name {
        color: #cbd5e1;
      }

      .user-avatar {
        border-color: rgba(255, 255, 255, 0.15);
        background: linear-gradient(135deg, rgba(255, 255, 255, 0.06) 0%, rgba(255, 255, 255, 0.02) 100%);
      }

      &:hover {
        background: linear-gradient(
          135deg,
          color-mix(in srgb, var(--theme-primary), transparent 85%) 0%,
          rgba(15, 23, 42, 0.6) 100%
        );
        border-color: color-mix(in srgb, var(--theme-primary), transparent 40%);
        box-shadow: 
          0 8px 24px var(--theme-primary-shadow),
          inset 0 1px 0 rgba(255, 255, 255, 0.15);

        .user-name {
          color: var(--theme-primary);
        }

        .user-avatar {
          border-color: transparent;
          box-shadow: 
            0 0 0 2px color-mix(in srgb, var(--theme-primary), transparent 60%),
            0 0 16px var(--theme-primary-light),
            0 4px 12px rgba(0, 0, 0, 0.4);
        }
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

      .ant-skeleton-input {
        width: 80px !important;
      }
    }
  }
}
</style>
