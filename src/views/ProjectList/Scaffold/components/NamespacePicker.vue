<script setup lang="ts">
import { computed, nextTick, watch } from 'vue';
import { message } from 'ant-design-vue';
import { getNamespaceErrorFeedback } from '../constant';
import { useGitlabNamespaces, type NamespaceTreeNode } from '../hooks/useGitlabNamespaces';

/** NamespacePicker 组件属性。 */
interface NamespacePickerProps {
  value?: string;
  disabled?: boolean;
  cacheKey: string;
  ready?: boolean;
}

/** NamespacePicker 组件事件。 */
interface NamespacePickerEmits {
  (event: 'update:value', value?: string): void;
}

/** TreeSelect labelInValue 结构。 */
interface NamespacePickerValue {
  value?: string | number;
  label?: string;
}

const props = withDefaults(defineProps<NamespacePickerProps>(), {
  value: undefined,
  disabled: false,
  ready: false,
});
const emit = defineEmits<NamespacePickerEmits>();

const {
  loading,
  displayTreeData,
  expandedKeys,
  searchStatusText,
  onTreeSearch,
  onTreeDropdownVisibleChange,
  handleTreeExpand,
  expandToNamespace,
  loadChildren,
  ensureOptionForId,
  getLabelById,
  clearSearch,
  resetNamespaceCache,
} = useGitlabNamespaces();

let lastInvalidValue = '';
let ensureRequestSeq = 0;

const selectedValue = computed({
  get: () => {
    if (!props.value) return undefined;
    return {
      value: props.value,
      label: getLabelById(props.value) || props.value,
    };
  },
  set: (value?: NamespacePickerValue | string | number) => {
    const nextValue = getTreeSelectValue(value);
    clearSearch();
    emit('update:value', nextValue);
  },
});

/** Namespace 下拉浮层样式配置。 */
const namespaceDropdownStyle = computed(() => ({
  width: 'min(720px, calc(100vw - 48px))',
  maxWidth: 'calc(100vw - 48px)',
  maxHeight: '420px',
  overflow: 'auto',
}));

/** Namespace 选择器占位提示。 */
const namespacePlaceholder = computed(() => (props.ready ? '搜索或选择 GitLab Group' : '请先完成 GitLab 登录'));

/**
 * 懒加载子分组。
 * @param treeNode TreeSelect 节点
 */
const handleLoadTreeData = async (treeNode: { dataRef?: NamespaceTreeNode }) => {
  const dataRef = treeNode.dataRef;
  if (!dataRef || dataRef.children) return;

  const groupId = Number(dataRef.value);
  if (!groupId || Number.isNaN(groupId)) return;

  dataRef.children = await loadChildren(groupId);
};

/**
 * 清空当前选择与搜索态。
 */
const handleClear = () => {
  clearSearch();
};

/**
 * 将选中节点滚动到下拉面板可视区域。
 */
const scrollSelectedNodeIntoView = async () => {
  await nextTick();
  window.setTimeout(() => {
    const selectedNode = document.querySelector('.yuyan-namespace-dropdown .ant-select-tree-node-selected');
    selectedNode?.scrollIntoView({ block: 'center' });
  }, 80);
};

/**
 * 从 TreeSelect 值中提取业务 value。
 * @param value TreeSelect 原始值
 * @returns Namespace ID
 */
const getTreeSelectValue = (value?: NamespacePickerValue | string | number): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') {
    return value.value === undefined || value.value === null ? undefined : String(value.value);
  }
  return String(value);
};

/**
 * 确保当前 Namespace 值可展示。
 * @param value Namespace ID
 */
const ensureNamespaceValue = async (value?: string) => {
  const requestSeq = (ensureRequestSeq += 1);
  const requestCacheKey = props.cacheKey;
  if (!props.ready || !value) return false;

  const result = await ensureOptionForId(value);
  if (
    result.cancelled ||
    requestSeq !== ensureRequestSeq ||
    !props.ready ||
    props.value !== value ||
    props.cacheKey !== requestCacheKey
  ) {
    return false;
  }

  if (result.valid) {
    lastInvalidValue = '';
    return true;
  }

  const feedback = getNamespaceErrorFeedback(result.error);
  const feedbackKey = `${requestCacheKey}:${value}:${feedback.message}`;
  if (lastInvalidValue !== feedbackKey) {
    if (feedback.level === 'error') {
      message.error(feedback.message);
    } else {
      message.warning(feedback.message);
    }
    lastInvalidValue = feedbackKey;
  }

  if (feedback.shouldClearSelection) {
    emit('update:value', undefined);
  }
  return false;
};

/**
 * 处理下拉显隐，关闭时清理搜索态，避免下次打开复用旧搜索树。
 * @param open 是否展开
 */
const handleDropdownVisibleChange = async (open: boolean) => {
  if (!open) {
    clearSearch();
    return;
  }
  if (!props.ready) return;
  await onTreeDropdownVisibleChange(open);
  const namespaceValid = props.value ? await ensureNamespaceValue(props.value) : false;
  if (namespaceValid && props.value) {
    await expandToNamespace(props.value);
    await scrollSelectedNodeIntoView();
  }
};

watch(
  () => [props.value, props.ready, props.cacheKey] as const,
  ([value, ready, cacheKey], previous) => {
    const previousCacheKey = previous?.[2];
    if (previousCacheKey !== undefined && previousCacheKey !== cacheKey) {
      resetNamespaceCache();
      lastInvalidValue = '';
      ensureRequestSeq += 1;
    }
    if (!ready) {
      ensureRequestSeq += 1;
      return;
    }
    void ensureNamespaceValue(value);
  },
  { immediate: true }
);
</script>

<template>
  <div class="namespace-picker">
    <a-tree-select
      v-model:value="selectedValue"
      :tree-data="displayTreeData"
      :load-data="handleLoadTreeData"
      :loading="loading"
      :disabled="disabled || !ready"
      :filter-tree-node="false"
      :field-names="{ label: 'title', value: 'value', children: 'children' }"
      allow-clear
      label-in-value
      show-search
      tree-node-label-prop="label"
      :placeholder="namespacePlaceholder"
      style="width: 100%"
      placement="bottomLeft"
      :list-height="340"
      :dropdown-match-select-width="false"
      :tree-expanded-keys="expandedKeys"
      popup-class-name="yuyan-namespace-dropdown"
      :dropdown-style="namespaceDropdownStyle"
      :not-found-content="searchStatusText || '暂无可选 GitLab Group'"
      @clear="handleClear"
      @search="onTreeSearch"
      @tree-expand="handleTreeExpand"
      @dropdown-visible-change="handleDropdownVisibleChange"
    />
    <div v-if="searchStatusText" class="namespace-picker__status">
      {{ searchStatusText }}
    </div>
  </div>
</template>

<style scoped lang="less">
@import '../style.less';
</style>
