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
</style>
