<script setup lang="ts">
import {
  ArrowUpOutlined,
  CheckOutlined,
  FolderOutlined,
  ReloadOutlined,
} from '@ant-design/icons-vue';
import { YButton } from '@yss-ui/components/lite';
import type { RemoteFsRoot } from '@/api/deploy';
import type { BreadcrumbSegment } from '../../hooks/useRemoteFsBrowse';

defineOptions({ name: 'RemoteFsToolbar' });

interface RemoteFsToolbarProps {
  currentPath: string;
  isAtRoot: boolean;
  loading: boolean;
  breadcrumbs: BreadcrumbSegment[];
  roots: RemoteFsRoot[];
  activeRoot: RemoteFsRoot | null;
}

defineProps<RemoteFsToolbarProps>();
const emit = defineEmits<{
  (e: 'update:currentPath', val: string): void;
  (e: 'navigateUp'): void;
  (e: 'refresh'): void;
  (e: 'usePath'): void;
  (e: 'jumpBreadcrumb', path: string): void;
  (e: 'switchRoot', root: RemoteFsRoot): void;
}>();
</script>

<template>
  <div class="remote-fs-toolbar">
    <div class="remote-fs-path-bar">
      <div class="nav-buttons">
        <YButton size="small" :disabled="isAtRoot || loading" @click="emit('navigateUp')">
          <template #icon><ArrowUpOutlined /></template>
          上级
        </YButton>
        <YButton size="small" :loading="loading" @click="emit('refresh')">
          <template #icon><ReloadOutlined /></template>
          刷新
        </YButton>
      </div>
      <div class="path-input-wrap">
        <a-input
          :value="currentPath"
          size="small"
          placeholder="输入路径后按回车进入"
          @update:value="(v: string) => emit('update:currentPath', v)"
          @pressEnter="emit('refresh')"
        />
      </div>
      <div class="action-buttons">
        <YButton type="primary" size="small" @click="emit('usePath')">
          <template #icon><CheckOutlined /></template>
          使用此路径
        </YButton>
      </div>
    </div>

    <div v-if="breadcrumbs.length > 0" class="remote-fs-breadcrumbs">
      <span
        v-for="(crumb, idx) in breadcrumbs"
        :key="crumb.path"
        class="crumb-item"
        :class="{ 'is-active': crumb.isLast }"
        @click="!crumb.isLast && emit('jumpBreadcrumb', crumb.path)"
      >
        {{ crumb.name }}
        <span v-if="idx < breadcrumbs.length - 1" class="crumb-separator">/</span>
      </span>
    </div>

    <div v-if="roots.length > 1" class="remote-fs-roots-bar">
      <span class="roots-label">快捷根：</span>
      <div class="roots-chips">
        <span
          v-for="root in roots"
          :key="root.id"
          class="root-chip"
          :class="{ 'is-selected': activeRoot?.id === root.id }"
          @click="emit('switchRoot', root)"
        >
          <FolderOutlined />
          {{ root.label }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
.remote-fs-toolbar {
  padding: 10px 16px;
  background: #ffffff;
  border-bottom: 1px solid #edf0f5;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.remote-fs-path-bar {
  display: flex;
  align-items: center;
  gap: 8px;

  .nav-buttons {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .path-input-wrap {
    flex: 1;
  }

  .action-buttons {
    display: flex;
    align-items: center;
    gap: 6px;
  }
}

.remote-fs-breadcrumbs {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: #595959;
  overflow-x: auto;
  white-space: nowrap;
  padding: 2px 0;

  .crumb-item {
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
    transition: all 0.2s;

    &:hover {
      background: #f0f0f0;
      color: #722ed1;
    }

    &.is-active {
      color: #1f1f1f;
      font-weight: 600;
      cursor: default;
      background: transparent;
    }
  }

  .crumb-separator {
    color: #bfbfbf;
  }
}

.remote-fs-roots-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;

  .roots-label {
    color: #8c8c8c;
    flex-shrink: 0;
  }

  .roots-chips {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .root-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 10px;
    border-radius: 12px;
    background: #f5f5f5;
    border: 1px solid #d9d9d9;
    color: #595959;
    cursor: pointer;
    transition: all 0.2s;

    &:hover {
      border-color: #9254de;
      color: #722ed1;
      background: #f9f0ff;
    }

    &.is-selected {
      border-color: #722ed1;
      background: #722ed1;
      color: #ffffff;
    }
  }
}
</style>
