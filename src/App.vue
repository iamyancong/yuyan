<template>
  <a-config-provider :theme="themeConfig" :locale="zhCN">
    <router-view />
  </a-config-provider>
</template>

<script setup lang="ts">
import { useTheme } from '@/hooks/useTheme';
import zhCN from 'ant-design-vue/es/locale/zh_CN';

const { themeConfig } = useTheme();
</script>

<style scoped></style>

<style lang="less">
html,
body,
#app {
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
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

/* =====================================================
 * 🔮 C4D风格高级 3D 玻璃拟态 (Glassmorphism) 下载通知卡片
 * 设计语言: 极光渐变、三维微立体、晶莹毛玻璃、温润动效
 * ===================================================== */
.ant-notification-notice.c4d-download-notification {
  background: 
    linear-gradient(135deg, rgba(255, 255, 255, 0.78) 0%, rgba(248, 250, 252, 0.55) 100%) padding-box,
    linear-gradient(135deg, rgba(124, 58, 237, 0.55) 0%, rgba(236, 72, 153, 0.35) 50%, rgba(59, 130, 246, 0.45) 100%) border-box !important;
  border: 1.5px solid transparent !important;
  border-radius: 20px !important;
  backdrop-filter: blur(20px) saturate(1.8) !important;
  -webkit-backdrop-filter: blur(20px) saturate(1.8) !important;
  box-shadow: 
    0 12px 40px rgba(31, 38, 135, 0.18),
    inset 0 1px 1px rgba(255, 255, 255, 0.8),
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
    background: linear-gradient(to bottom, rgba(255, 255, 255, 0.45) 0%, rgba(255, 255, 255, 0) 100%);
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
    color: #1f2937 !important;
    margin-left: 0 !important; /* 移除侧边 margin 偏移，防止文字被推挤 */
    margin-bottom: 8px !important;
  }

  .ant-notification-notice-description {
    margin-left: 0 !important; /* 移除侧边 margin 偏移，对齐标题 */
    color: #4b5563 !important;
    font-size: 13px !important;
  }

  .ant-notification-notice-close {
    color: rgba(0, 0, 0, 0.45) !important;
    top: 18px !important;
    right: 20px !important;
    transition: all 0.2s ease;

    &:hover {
      color: #7c3aed !important;
      transform: scale(1.1) rotate(90deg);
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
    background: rgba(0, 0, 0, 0.06);
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
        width: 100%;
        background: linear-gradient(90deg, #7c3aed, #ec4899, #3b82f6, #7c3aed);
        background-size: 200% 100%;
        animation: c4d-bar-flow 2s linear infinite;
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
