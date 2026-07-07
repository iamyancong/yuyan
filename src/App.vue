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
</style>


