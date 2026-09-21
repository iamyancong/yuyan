<template>
  <a-config-provider :theme="themeConfig" :locale="zhCN">
    <router-view />
    <AppSplash v-if="showSplash" @finished="showSplash = false" />
  </a-config-provider>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useTheme } from '@/hooks/useTheme';
import { isTauri } from '@/utils/env';
import AppSplash from '@/components/AppSplash.vue';
import zhCN from 'ant-design-vue/es/locale/zh_CN';

/** 生产环境当前 WebView 会话已展示开屏动画的标记。 */
const SPLASH_SHOWN_SESSION_KEY = 'yuyan:splash-shown';

/**
 * 判断本次页面载入是否需要展示开屏动画。
 * 浏览器环境不展示；Tauri 开发环境每次载入都展示，生产环境同一 WebView 会话仅首次展示。
 * @returns 是否展示开屏动画
 */
const shouldShowSplash = (): boolean => {
  if (!isTauri()) return false;
  if (typeof window !== 'undefined' && window.location.hash.includes('floating-notification')) return false;
  if (import.meta.env.DEV) return true;

  try {
    if (sessionStorage.getItem(SPLASH_SHOWN_SESSION_KEY)) return false;
    sessionStorage.setItem(SPLASH_SHOWN_SESSION_KEY, 'true');
  } catch {
    /** sessionStorage 不可用时保留原有行为，避免冷启动缺少开屏动画。 */
  }

  return true;
};

const { themeConfig } = useTheme();
const showSplash = ref(shouldShowSplash());
</script>

<style scoped></style>

<style lang="less">
html:not(.is-transparent-window) {
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
  background-color: var(--bg-color, var(--boot-background-color, #f0f2f5));

  body,
  #app {
    height: 100%;
    margin: 0;
    padding: 0;
    overflow: hidden;
    background-color: var(--bg-color, var(--boot-background-color, #f0f2f5));
  }
}

html.is-transparent-window,
html.is-transparent-window body,
html.is-transparent-window #app,
html.is-transparent-window .ant-app {
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
  background: transparent !important;
  background-color: transparent !important;
}

/* =====================================================
 * 🪟 全局抽屉（Drawer）内边距规范
 * 将 Ant Design Vue 默认 24px 内边距全局收窄为 16px，提升空间利用率
 * ===================================================== */
.ant-drawer .ant-drawer-body {
  padding: 16px;
}

/* =====================================================
 * 🎨 全局精致现代滚动条规范
 * 特性：6px/7px 胶囊滑块、半透明、自适应亮/暗主题、悬浮过渡
 * ===================================================== */
* {
  scrollbar-width: thin;
  scrollbar-color: rgba(0, 0, 0, 0.2) transparent;
}

::-webkit-scrollbar {
  width: 7px;
  height: 7px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 999px;
  transition: background-color 0.2s ease;

  &:hover {
    background: rgba(0, 0, 0, 0.38);
  }

  &:active {
    background: rgba(0, 0, 0, 0.5);
  }
}

/* 暗黑主题下滚动条自适应 */
html[data-theme='dark'] {
  * {
    scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
  }

  ::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.2);

    &:hover {
      background: rgba(255, 255, 255, 0.36);
    }

    &:active {
      background: rgba(255, 255, 255, 0.48);
    }
  }
}

/* 兼容 vxe-table / 局部容器内部滚动条 */
.vxe-table--body-wrapper,
.vxe-table--scroll-y-wrapper,
.vxe-table--scroll-x-wrapper {
  &::-webkit-scrollbar {
    width: 7px;
    height: 7px;
  }
}

/* 全局覆盖：dropdown / YTable 操作列「更多」Popover 内的链接按钮走主题色（弹出层 teleport 到 body） */
.ant-dropdown {
  .ant-dropdown-menu {
    .ant-dropdown-menu-item {
      color: var(--text-color);

      a,
      .ant-btn-link,
      .ant-btn-text {
        color: var(--primary-color) !important;

        &:hover {
          color: var(--primary-color-hover) !important;
        }

        &[disabled],
        &.ant-btn-background-ghost[disabled] {
          color: var(--text-color-tertiary) !important;
          opacity: 0.5;
          cursor: not-allowed;
        }
      }

      &.ant-dropdown-menu-item-active,
      &:hover {
        background-color: var(--primary-color-lighter);
      }
    }
  }
}

/* YTable 操作列「更多」使用 Popover，非 Dropdown */
.ant-popover {
  .y-table-action-pop-list {
    .ant-btn-link,
    .y-table-action-link {
      color: var(--primary-color) !important;

      &:hover:not(:disabled) {
        color: var(--primary-color-hover) !important;
        opacity: 0.8;
      }

      &:disabled,
      &[disabled] {
        color: var(--text-color-tertiary) !important;
        opacity: 0.5;
        cursor: not-allowed;
      }
    }
  }
}

/* =====================================================
 * 🎯 YTable 操作列按钮与 Loading 样式对齐规范
 * 解决 a-button 在 inline-block 下 loading-icon 与文本 baseline 不一致导致图标下沉的问题
 * ===================================================== */
.y-table-action-list,
.y-table-action-pop-list {
  .ant-btn.y-table-action-link,
  .ant-btn.y-table-action-btn,
  .ant-btn-link,
  .ant-btn-text {
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    vertical-align: middle !important;

    .ant-btn-loading-icon {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
    }
  }
}

/* 强制主按钮（含第三方组件库按钮）走全局配置的主题色变量，应对跨实例和打包外部化失效 */
.ant-btn-primary {
  background-color: var(--primary-color) !important;
  border-color: var(--primary-color) !important;
  color: #ffffff !important;
  box-shadow: 0 2px 0 var(--primary-color-lighter);
  transition: all 0.2s cubic-bezier(0.645, 0.045, 0.355, 1);

  &,
  span,
  .anticon {
    color: #ffffff !important;
  }

  &:hover,
  &:focus {
    background-color: var(--primary-color-hover) !important;
    border-color: var(--primary-color-hover) !important;
    color: #ffffff !important;

    &,
    span,
    .anticon {
      color: #ffffff !important;
    }
  }

  &:active {
    background-color: var(--primary-color-active) !important;
    border-color: var(--primary-color-active) !important;
    color: #ffffff !important;

    &,
    span,
    .anticon {
      color: #ffffff !important;
    }
  }

  &[disabled],
  &.ant-btn-background-ghost[disabled] {
    background-color: var(--border-color-split) !important;
    border-color: var(--border-color-split) !important;
    color: var(--text-color-tertiary) !important;
    opacity: 0.6;
    cursor: not-allowed;

    &,
    span,
    .anticon {
      color: var(--text-color-tertiary) !important;
    }
  }
}

/* Formily 内部可能使用独立的 Ant Design Vue 上下文，Switch 开启态直接消费全局主题变量。 */
.ant-switch.ant-switch-checked {
  background: var(--primary-color) !important;

  &:hover:not(.ant-switch-disabled) {
    background: var(--primary-color-hover) !important;
  }

  &:focus-visible {
    outline: 3px solid var(--primary-color-light);
    outline-offset: 2px;
  }
}

/* =====================================================
 * 🔮 C4D风格高级 3D 玻璃拟态 (Glassmorphism) 下载通知卡片
 * 设计语言: 极光渐变、三维微立体、晶莹毛玻璃、温润动效
 * ===================================================== */
.ant-notification-notice.c4d-download-notification {
  background: 
    linear-gradient(135deg, var(--glass-bg-heavy) 0%, var(--glass-bg) 100%) padding-box,
    linear-gradient(135deg, rgba(124, 58, 237, 0.55) 0%, rgba(236, 72, 153, 0.35) 50%, rgba(59, 130, 246, 0.45) 100%) border-box !important;
  border: 1.5px solid transparent !important;
  border-radius: 20px !important;
  backdrop-filter: blur(20px) saturate(1.8) !important;
  -webkit-backdrop-filter: blur(20px) saturate(1.8) !important;
  box-shadow: 
    var(--glass-shadow),
    var(--glass-inset-shadow),
    inset 0 -2px 4px rgba(124, 58, 237, 0.08) !important;
  overflow: hidden;
  position: relative;
  padding: 20px 24px 20px 52px !important; /* 给左侧绝对定位的 LED 呼吸灯留出充足空间 */
  transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);

  &::after {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 40%;
    background: linear-gradient(to bottom, var(--glass-bg) 0%, transparent 100%);
    border-radius: 20px 20px 0 0;
    pointer-events: none;
    z-index: 1;
  }

  /* 💡 强制覆盖默认图标容器定位，解决自带 info 图标和自定义 LED 重叠重合的问题 */
  .ant-notification-notice-icon {
    position: absolute !important;
    left: 24px !important;
    top: 24px !important;
    margin-left: 0 !important;
    display: flex !important;
    align-items: center !important;
    font-size: 0 !important; /* 隐藏默认 svg 框架的大小 */
    line-height: 1 !important;
  }

  .ant-notification-notice-message {
    font-size: 15px !important;
    font-weight: 700 !important;
    color: var(--text-color) !important;
    margin-left: 0 !important; /* 移除侧边 margin 偏移，防止文字被推挤 */
    margin-bottom: 8px !important;
  }

  .ant-notification-notice-description {
    margin-left: 0 !important; /* 移除侧边 margin 偏移，对齐标题 */
    color: var(--text-color-secondary) !important;
    font-size: 13px !important;
  }

  .ant-notification-notice-close {
    z-index: 3;
    display: grid !important;
    width: 28px;
    height: 28px;
    place-items: center;
    color: var(--text-color-tertiary) !important;
    top: 14px !important;
    right: 14px !important;
    border-radius: 9px;
    background: color-mix(in srgb, var(--bg-color-container) 60%, transparent);
    transition: all 0.2s ease;

    &:hover {
      color: var(--primary-color) !important;
      transform: scale(1.1) rotate(90deg);
    }
  }
}

/* 🔮 雨燕全局右上角通知避让顶部导航栏（防止紧贴顶部或被截断） */
.ant-notification.ant-notification-topRight {
  top: 76px !important;
}

/* 🔮 雨燕原生 Notification 兜底拟态美化：即使未指定自定义类名，也自动享有高级玻璃拟态与大圆角 */
.ant-notification-notice:not(.c4d-download-notification) {
  border-radius: 16px !important;
  backdrop-filter: blur(24px) saturate(180%) !important;
  -webkit-backdrop-filter: blur(24px) saturate(180%) !important;
  border: 1px solid rgba(255, 255, 255, 0.85) !important;
  box-shadow:
    0 20px 45px -8px rgba(99, 102, 241, 0.18),
    0 4px 16px -2px rgba(15, 23, 42, 0.06),
    inset 0 1px 1.5px rgba(255, 255, 255, 0.95) !important;
}

/* 🔮 雨燕高阶 C4D 玻璃拟态通知卡片（与 macOS 下载通知同规） */
.ant-notification-notice.yuyan-glass-notification {
  width: 410px !important;
  max-width: calc(100vw - 32px) !important;
  padding: 16px 18px !important;
  border-radius: 16px !important;
  background: linear-gradient(
    145deg,
    rgba(255, 255, 255, 0.96) 0%,
    rgba(248, 250, 255, 0.92) 50%,
    rgba(241, 245, 254, 0.9) 100%
  ) !important;
  backdrop-filter: blur(24px) saturate(180%) !important;
  -webkit-backdrop-filter: blur(24px) saturate(180%) !important;
  border: 1px solid rgba(255, 255, 255, 0.9) !important;
  box-shadow:
    0 20px 45px -8px rgba(99, 102, 241, 0.22),
    0 4px 16px -2px rgba(15, 23, 42, 0.08),
    inset 0 1px 1.5px rgba(255, 255, 255, 0.95) !important;
  overflow: visible !important;

  .ant-notification-notice-content {
    overflow: visible;
  }

  .ant-notification-notice-message {
    margin-bottom: 8px !important;
    margin-left: 0 !important;

    .glass-noti-title-wrap {
      display: flex;
      align-items: center;
      gap: 8px;

      .glass-noti-icon-box {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: 8px;
        background: linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(168, 85, 247, 0.18) 100%);
        border: 1px solid rgba(99, 102, 241, 0.25);
        box-shadow: 0 2px 6px rgba(99, 102, 241, 0.12);

        .glass-noti-type-icon,
        .glass-noti-apple-icon {
          font-size: 16px;
          color: #4f46e5;
        }

        &.is-success {
          background: linear-gradient(135deg, rgba(16, 185, 129, 0.15) 0%, rgba(5, 150, 105, 0.22) 100%);
          border-color: rgba(16, 185, 129, 0.32);
          box-shadow: 0 2px 8px rgba(16, 185, 129, 0.18);
          .glass-noti-type-icon { color: #059669; }
        }

        &.is-warning {
          background: linear-gradient(135deg, rgba(245, 158, 11, 0.16) 0%, rgba(217, 119, 6, 0.22) 100%);
          border-color: rgba(245, 158, 11, 0.32);
          box-shadow: 0 2px 8px rgba(245, 158, 11, 0.18);
          .glass-noti-type-icon { color: #d97706; }
        }

        &.is-error {
          background: linear-gradient(135deg, rgba(239, 68, 68, 0.16) 0%, rgba(220, 38, 38, 0.22) 100%);
          border-color: rgba(239, 68, 68, 0.32);
          box-shadow: 0 2px 8px rgba(239, 68, 68, 0.18);
          .glass-noti-type-icon { color: #dc2626; }
        }
      }

      .glass-noti-title {
        font-size: 14px;
        font-weight: 700;
        color: #1e1b4b;
        letter-spacing: 0.2px;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .glass-noti-badge {
        display: inline-flex;
        align-items: center;
        padding: 1px 7px;
        font-size: 10px;
        font-weight: 600;
        font-family: var(--font-family-code, monospace);
        color: #6366f1;
        background: rgba(99, 102, 241, 0.09);
        border: 1px solid rgba(99, 102, 241, 0.2);
        border-radius: 6px;
        white-space: nowrap;

        &.is-success {
          color: #059669;
          background: rgba(16, 185, 129, 0.1);
          border-color: rgba(16, 185, 129, 0.25);
        }

        &.is-warning {
          color: #d97706;
          background: rgba(245, 158, 11, 0.1);
          border-color: rgba(245, 158, 11, 0.25);
        }

        &.is-error {
          color: #dc2626;
          background: rgba(239, 68, 68, 0.1);
          border-color: rgba(239, 68, 68, 0.25);
        }
      }
    }
  }

  .ant-notification-notice-description {
    margin-left: 0 !important;

    .glass-noti-body {
      display: flex;
      flex-direction: column;
      gap: 7px;

      .glass-noti-desc {
        margin: 0;
        font-size: 12.5px;
        line-height: 1.5;
        color: #475569;
        word-break: break-all;
      }

      .glass-noti-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 4px;

        .glass-noti-action-btn {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          height: 24px;
          padding: 0 10px;
          font-size: 11.5px;
          font-weight: 500;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);

          &.is-primary {
            color: #ffffff;
            background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
            border: none;
            box-shadow: 0 2px 6px rgba(124, 58, 237, 0.35);

            &:hover {
              background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
              transform: translateY(-1px);
              box-shadow: 0 4px 10px rgba(124, 58, 237, 0.45);
            }
          }

          &.is-default {
            color: var(--primary-color, #4f46e5);
            background: rgba(99, 102, 241, 0.08);
            border: 1px solid rgba(99, 102, 241, 0.2);

            &:hover {
              background: rgba(99, 102, 241, 0.15);
              border-color: rgba(99, 102, 241, 0.35);
              transform: translateY(-0.5px);
            }
          }
        }
      }

      .glass-noti-cmd-box {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 6px 9px;
        background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%);
        border-radius: 7px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.5);

        .glass-noti-cmd-content {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
          flex: 1;

          .glass-noti-cmd-prompt {
            font-family: Menlo, Monaco, monospace;
            font-size: 11px;
            font-weight: bold;
            color: #10b981;
            user-select: none;
            text-shadow: 0 0 4px rgba(16, 185, 129, 0.4);
          }

          .glass-noti-cmd-code {
            font-family: Menlo, Monaco, monospace;
            font-size: 10.5px;
            color: #f1f5f9;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            user-select: all;
          }
        }

        .glass-noti-btn-copy {
          flex-shrink: 0;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          height: 22px;
          padding: 0 8px;
          font-size: 10.5px;
          font-weight: 500;
          color: #ffffff;
          background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
          border: none;
          border-radius: 5px;
          cursor: pointer;
          box-shadow: 0 2px 6px rgba(124, 58, 237, 0.35);
          transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);

          &:hover {
            background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
            transform: translateY(-0.5px);
          }

          .copy-icon {
            font-size: 10px;
          }
        }
      }

      .glass-noti-tip {
        font-size: 10.5px;
        color: #94a3b8;
        line-height: 1.4;
      }
    }
  }

  .ant-notification-notice-close {
    top: 14px !important;
    right: 14px !important;
    color: #94a3b8 !important;
    transition: all 0.2s ease !important;

    &:hover {
      color: #4f46e5 !important;
      transform: scale(1.1) rotate(90deg) !important;
    }
  }
}

/* 暗色模式适配 */
body.dark .ant-notification-notice.yuyan-glass-notification,
.is-dark .ant-notification-notice.yuyan-glass-notification {
  background: linear-gradient(
    145deg,
    rgba(24, 27, 42, 0.96) 0%,
    rgba(18, 21, 35, 0.94) 50%,
    rgba(15, 17, 28, 0.92) 100%
  ) !important;
  border-color: rgba(255, 255, 255, 0.12) !important;
  box-shadow:
    0 20px 45px -8px rgba(0, 0, 0, 0.6),
    0 6px 18px -2px rgba(0, 0, 0, 0.4),
    inset 0 1px 1px rgba(255, 255, 255, 0.08) !important;

  .glass-noti-icon-box {
    background: rgba(255, 255, 255, 0.06) !important;
    border-color: rgba(255, 255, 255, 0.12) !important;

    .glass-noti-type-icon,
    .glass-noti-apple-icon {
      color: #a5b4fc !important;
    }

    &.is-success .glass-noti-type-icon { color: #34d399 !important; }
    &.is-warning .glass-noti-type-icon { color: #fbbf24 !important; }
    &.is-error .glass-noti-type-icon { color: #f87171 !important; }
  }

  .ant-notification-notice-message .glass-noti-title-wrap {
    .glass-noti-title {
      color: #e2e8f0 !important;
    }

    .glass-noti-badge {
      color: #a5b4fc !important;
      background: rgba(129, 140, 248, 0.15) !important;
      border-color: rgba(129, 140, 248, 0.3) !important;

      &.is-success {
        color: #34d399 !important;
        background: rgba(16, 185, 129, 0.18) !important;
        border-color: rgba(16, 185, 129, 0.35) !important;
      }

      &.is-warning {
        color: #fbbf24 !important;
        background: rgba(245, 158, 11, 0.18) !important;
        border-color: rgba(245, 158, 11, 0.35) !important;
      }

      &.is-error {
        color: #f87171 !important;
        background: rgba(239, 68, 68, 0.18) !important;
        border-color: rgba(239, 68, 68, 0.35) !important;
      }
    }
  }

  .ant-notification-notice-description .glass-noti-body {
    .glass-noti-desc {
      color: #94a3b8 !important;
    }

    .glass-noti-actions {
      .glass-noti-action-btn.is-default {
        color: #c7d2fe !important;
        background: rgba(99, 102, 241, 0.15) !important;
        border-color: rgba(99, 102, 241, 0.3) !important;

        &:hover {
          background: rgba(99, 102, 241, 0.25) !important;
        }
      }
    }

    .glass-noti-cmd-box {
      background: rgba(0, 0, 0, 0.6) !important;
      border-color: rgba(255, 255, 255, 0.08) !important;
    }

    .glass-noti-tip {
      color: #64748b !important;
    }
  }
}

/* 🔮 C4D风格百分比字体样式 */
.c4d-percent-text {
  font-family: 'Outfit', 'Inter', monospace;
  font-size: 14px;
  font-weight: 800;
  color: #7c3aed;
  text-shadow: 0 0 8px rgba(124, 58, 237, 0.4);

  &.success {
    color: #10b981;
    text-shadow: 0 0 8px rgba(16, 185, 129, 0.4);
  }
}

/* 🔮 C4D风格高级进度条 */
.c4d-progress-wrapper {
  margin-top: 14px;
  position: relative;
  z-index: 2;

  .c4d-progress-track {
    height: 8px;
    background: var(--border-color-split);
    border-radius: 6px;
    overflow: hidden;
    position: relative;
    box-shadow: 
      inset 0 1px 2px rgba(0, 0, 0, 0.1),
      0 1px 0 rgba(255, 255, 255, 0.5);

    .c4d-progress-bar {
      height: 100%;
      border-radius: 6px;
      transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      position: relative;
      box-shadow: 
        0 1px 2px rgba(0, 0, 0, 0.15),
        inset 0 1px 0 rgba(255, 255, 255, 0.4);

      &.is-downloading {
        width: 34%;
        background: linear-gradient(90deg, #7c3aed, #ec4899, #3b82f6, #7c3aed);
        background-size: 200% 100%;
        animation: c4d-bar-indeterminate 1.4s ease-in-out infinite, c4d-bar-flow 2s linear infinite;
      }

      &.is-success {
        width: 100%;
        background: linear-gradient(90deg, #10b981, #3b82f6);
        box-shadow: 
          0 0 10px rgba(16, 185, 129, 0.5),
          inset 0 1px 0 rgba(255, 255, 255, 0.4);
      }

      &.is-error {
        width: 100%;
        background: linear-gradient(90deg, #ef4444, #f59e0b);
        box-shadow: 
          0 0 10px rgba(239, 68, 68, 0.5),
          inset 0 1px 0 rgba(255, 255, 255, 0.4);
      }
    }
  }
}

/* 流光动画关键帧 */
@keyframes c4d-bar-flow {
  0% {
    background-position: 0% 0%;
  }
  100% {
    background-position: -200% 0%;
  }
}

@keyframes c4d-bar-indeterminate {
  0% {
    transform: translateX(-120%);
  }
  100% {
    transform: translateX(320%);
  }
}

/* 状态 LED 呼吸灯 */
.c4d-status-led {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  animation: c4d-led-glow 2s ease-in-out infinite;
  flex-shrink: 0;

  &.is-downloading {
    background: linear-gradient(135deg, #7c3aed 0%, #3b82f6 100%);
    box-shadow: 0 0 8px rgba(124, 58, 237, 0.7);
  }

  &.is-success {
    background: linear-gradient(135deg, #10b981 0%, #059669 100%);
    box-shadow: 0 0 8px rgba(16, 185, 129, 0.7);
  }

  &.is-error {
    background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
    box-shadow: 0 0 8px rgba(239, 68, 68, 0.7);
  }
}

@keyframes c4d-led-glow {
  0%, 100% {
    opacity: 0.6;
    transform: scale(0.95);
  }
  50% {
    opacity: 1;
    transform: scale(1.15);
  }
}

/* 🔍 在文件夹中定位文件按钮（果冻微纽） */
.c4d-locate-btn {
  margin-top: 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 14px;
  border-radius: 14px;
  background: linear-gradient(135deg, #7c3aed 0%, #ec4899 100%);
  color: #ffffff !important;
  font-size: 12px;
  font-weight: 600;
  border: none;
  outline: none;
  box-shadow: 
    0 4px 10px rgba(236, 72, 153, 0.25),
    inset 0 1px 1px rgba(255, 255, 255, 0.3);
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
  text-decoration: none !important;

  &:hover {
    transform: scale(1.05) translateY(-1px);
    box-shadow: 
      0 6px 15px rgba(236, 72, 153, 0.4),
      inset 0 1px 1px rgba(255, 255, 255, 0.45);
    background: linear-gradient(135deg, #8753f7 0%, #ee59a3 100%);
  }

  &:active {
    transform: scale(0.95) translateY(0.5px);
    box-shadow: 0 2px 4px rgba(236, 72, 153, 0.2);
  }
}
</style>
