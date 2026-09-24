<script setup lang="ts">
import {
  ArrowRightOutlined,
  ArrowUpOutlined,
  CheckOutlined,
  CloseCircleFilled,
  CloseOutlined,
  CopyOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FolderOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons-vue';
import type { RemoteFsToolbarEmits, RemoteFsToolbarProps } from './constant';
import { useCopyFeedback } from './hooks/useCopyFeedback';
import { usePathEdit } from './hooks/usePathEdit';

defineOptions({ name: 'RemoteFsToolbar' });

const props = defineProps<RemoteFsToolbarProps>();
const emit = defineEmits<RemoteFsToolbarEmits>();

const { isEditingPath, inputRef, enterEditMode, cancelEditMode, submitPathEdit } = usePathEdit(
  () => props.currentPath,
  (val) => emit('update:pathInput', val),
  () => emit('navigateToPath')
);

const { isCopied, triggerCopy } = useCopyFeedback(() => emit('copyPath', props.currentPath));
</script>

<template>
  <div class="remote-fs-toolbar">
    <div class="toolbar-main-bar">
      <!-- 1. 紧凑型导航控制组 -->
      <div class="nav-control-group">
        <button
          type="button"
          class="nav-action-btn"
          :disabled="isAtRoot || loading"
          title="返回上一级 (Alt+↑)"
          @click="emit('navigateUp')"
        >
          <ArrowUpOutlined />
        </button>
        <div class="nav-divider" />
        <button
          type="button"
          class="nav-action-btn"
          :disabled="loading"
          :class="{ 'is-loading': loading }"
          title="刷新目录"
          @click="emit('refresh')"
        >
          <ReloadOutlined :spin="loading" />
        </button>
      </div>

      <!-- 2. 一体化智能地址栏 (Omnibar) -->
      <div class="omnibar-wrap" :class="{ 'is-editing': isEditingPath }">
        <!-- 浏览态：面包屑与行内快速动作 -->
        <div v-if="!isEditingPath" class="omnibar-breadcrumbs" @click.self="enterEditMode">
          <FolderOutlined class="omnibar-folder-icon" />
          <span class="crumb-root">/</span>
          <template v-for="crumb in breadcrumbs" :key="crumb.path">
            <button
              type="button"
              class="crumb-chip"
              :class="{ 'is-active': crumb.isLast, 'is-disabled': crumb.disabled }"
              :disabled="crumb.disabled || crumb.isLast"
              :title="crumb.disabled ? crumb.disabledReason : `跳转至 ${crumb.path}`"
              @click.stop="emit('jumpBreadcrumb', crumb.path)"
            >
              {{ crumb.name }}
            </button>
            <span v-if="!crumb.isLast" class="crumb-sep">/</span>
          </template>

          <div class="omnibar-inline-actions">
            <button
              type="button"
              class="omnibar-action-icon-btn"
              :class="{ 'is-copied': isCopied }"
              :title="isCopied ? '已复制完整路径' : '复制当前路径'"
              @click.stop="triggerCopy"
            >
              <CheckOutlined v-if="isCopied" class="success-icon" />
              <CopyOutlined v-else />
            </button>
            <button
              type="button"
              class="omnibar-action-icon-btn"
              title="自由编辑完整路径"
              @click.stop="enterEditMode"
            >
              <EditOutlined />
            </button>
          </div>
        </div>

        <!-- 编辑态：全行自由输入 -->
        <div v-else class="omnibar-edit-form">
          <FolderOutlined class="edit-prefix-icon" />
          <input
            ref="inputRef"
            class="edit-input-field"
            :value="pathInput"
            placeholder="输入远程绝对路径后按回车跳转"
            @input="(e: any) => emit('update:pathInput', e.target.value)"
            @keydown.enter="submitPathEdit"
            @keydown.esc="cancelEditMode"
          />
          <div class="edit-action-group">
            <button type="button" class="edit-tool-btn submit" title="确认跳转 (Enter)" @click="submitPathEdit">
              <ArrowRightOutlined />
            </button>
            <button type="button" class="edit-tool-btn cancel" title="取消 (Esc)" @click="cancelEditMode">
              <CloseOutlined />
            </button>
          </div>
        </div>
      </div>

      <!-- 3. 右侧视图与检索控制组 -->
      <div class="toolbar-tools-group">
        <!-- 紧凑搜索过滤胶囊 -->
        <div class="filter-search-capsule" :class="{ 'has-value': Boolean(filterKeyword) }">
          <SearchOutlined class="search-lead-icon" />
          <input
            class="search-input-field"
            :value="filterKeyword"
            placeholder="过滤当前目录..."
            @input="(e: any) => emit('update:filterKeyword', e.target.value)"
          />
          <button
            v-if="filterKeyword"
            type="button"
            class="clear-filter-btn"
            title="清空过滤"
            @click="emit('update:filterKeyword', '')"
          >
            <CloseCircleFilled />
          </button>
        </div>

        <!-- 现代化隐藏项切换胶囊 (取代原有原生 Checkbox) -->
        <button
          type="button"
          class="view-toggle-pill"
          :class="{ 'is-active': showHidden }"
          :title="showHidden ? '隐藏以点开头的项' : '显示以点开头的隐藏项'"
          @click="emit('update:showHidden', !showHidden)"
        >
          <EyeOutlined v-if="showHidden" class="toggle-icon" />
          <EyeInvisibleOutlined v-else class="toggle-icon" />
          <span class="toggle-label">隐藏项</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
