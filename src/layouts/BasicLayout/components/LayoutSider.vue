<script setup lang="ts">
import { computed } from 'vue';
import LogoSwift from '@/components/LogoSwift.vue';
import { useTheme } from '@/hooks/useTheme';
import { useNavigation } from '../hooks/useNavigation';
import { isTauri } from '@/utils/env';
import { detectPlatform } from '@/utils/platformDetect';

defineOptions({ name: 'LayoutSider' });

defineProps<{
  /** 侧边栏折叠状态 */
  collapsed: boolean;
}>();

defineEmits<{
  /** 触发更新折叠状态 */
  (e: 'update:collapsed', value: boolean): void;
}>();

const { menuTheme } = useTheme();
const { selectedKeys, menuItems, onMenuClick, goHome } = useNavigation();

// 平台检测
const isTauriClient = isTauri();
const platformInfo = detectPlatform();
const isMac = platformInfo.platform === 'darwin';
const isTauriMac = computed(() => isTauriClient && isMac);
</script>

<template>
  <a-layout-sider 
    :theme="menuTheme" 
    collapsible 
    :collapsed="collapsed" 
    @update:collapsed="$emit('update:collapsed', $event)"
  >
    <div class="brand" :class="{ 'is-tauri-mac-brand': isTauriMac }" data-tauri-drag-region>
      <div class="brand-content" @click="goHome">
        <div class="brand-logo">
          <LogoSwift :size="28" />
        </div>
        <div class="brand-name" v-show="!collapsed">雨燕 SwiftVPN</div>
      </div>
    </div>
    
    <a-menu 
      :theme="menuTheme" 
      mode="inline" 
      :selectedKeys="selectedKeys" 
      @click="onMenuClick"
    >
      <a-menu-item v-for="item in menuItems" :key="item.key">
        <template #icon>
          <component :is="item.icon" />
        </template>
        {{ item.label }}
      </a-menu-item>
    </a-menu>
  </a-layout-sider>
</template>

<style scoped lang="less">
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

  &.is-tauri-mac-brand {
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
  background: transparent;
  color: #0f172a;
}

.brand-name {
  font-weight: 700;
  letter-spacing: 0.2px;
  color: var(--text-color);
  font-size: 15px;
  white-space: nowrap;
}

// 1. 亮色（Light）侧边栏进化
&.ant-layout-sider-light {
  background: linear-gradient(180deg, #fbfcfd 0%, #f3f5f8 100%) !important;
  border-right: 1px solid #e2e8f0;

  .brand {
    border-bottom: 1px solid #e8edf3;
  }

  .brand-logo {
    background: transparent !important;
    color: var(--primary-color);
  }

  .brand-name {
    color: #1e293b;
  }

  :deep(.ant-menu-light) {
    background: transparent !important;
    border-inline-end: none !important;
  }

  // 菜单项卡片悬浮化
  :deep(.ant-menu-item) {
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
  :deep(.ant-layout-sider-trigger) {
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
&.ant-layout-sider-dark {
  background: #141414 !important; /* 与右侧暗色背景完全一致的暗灰色 */
  border-right: 1px solid var(--border-color-split);

  .brand {
    border-bottom: 1px solid var(--border-color-split);
  }

  .brand-logo {
    background: transparent !important;
    color: #ffffff;
  }

  .brand-name {
    color: rgba(255, 255, 255, 0.95);
  }

  :deep(.ant-menu-dark) {
    background: transparent !important;
  }

  // 菜单项卡片悬浮化
  :deep(.ant-menu-item) {
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
      
      .ant-menu-item-icon {
        color: #ffffff !important;
      }
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
  :deep(.ant-layout-sider-trigger) {
    background: #141414 !important;
    border-top: 1px solid var(--border-color-split);
    color: #94a3b8 !important;
    &:hover {
      background: var(--bg-color-elevated) !important;
      color: #ffffff !important;
    }
  }
}

// 侧边栏折叠时的水平居中适配
&.ant-layout-sider-collapsed {
  .brand {
    padding-left: 0 !important;
    padding-right: 0 !important;
  }
  .brand-content {
    justify-content: center !important;
  }

  :deep(.ant-menu-item) {
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
</style>
