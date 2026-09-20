<script setup lang="ts">
import { computed, watch } from 'vue';
import { BulbOutlined, FolderOpenFilled, FolderOpenOutlined, LoadingOutlined } from '@ant-design/icons-vue';
import { useDeployRootRecommendation, type DeployRootSelectOption } from '../../../../hooks/useDeployRootRecommendation';
import { useNginxDeployContext } from '../../../../hooks/useNginxDeployContext';
import { extractOccupiedMap, type DeployRootFieldProps } from './constant';

defineOptions({ name: 'DeployRootField' });

const props = defineProps<DeployRootFieldProps>();
const emit = defineEmits<{
  'update:modelValue': [value: string];
  'toggleExplorer': [];
  'update:occupiedMap': [value: Record<string, string>];
}>();

const context = useNginxDeployContext();

const currentServer = computed(() => {
  if (!props.serverId) return null;
  return context?.servers?.value?.find((s) => s.id === Number(props.serverId)) || null;
});

const {
  loading, hint, options, recommendation, autoManaged, canApplyRecommendation,
  applyRecommendation, filterOption, handleFocus, handleSelect, handleValueChange,
} = useDeployRootRecommendation(props, emit);

// 提取并向外同步被占用的目录字典
watch(
  options,
  (opts) => {
    emit('update:occupiedMap', extractOccupiedMap(opts || []));
  },
  { immediate: true, deep: true }
);

/** 当前提示是否属于警告状态。 */
const warning = computed(() => /失败|未能|未生成|未识别|已被|已由|冲突/.test(hint.value));

/** 转发 AutoComplete 选择事件。 */
const onSelect = (value: string, option: DeployRootSelectOption) => handleSelect(value, option);

/** 转发后端路径输入值。 */
const onBackendValueChange = (value: string) => emit('update:modelValue', value || '');

/** 将下拉面板挂载到字段容器，使其跟随弹窗内容滚动。 */
const getPopupContainer = (triggerNode: HTMLElement) =>
  triggerNode.closest<HTMLElement>('.deploy-root-field') || triggerNode.parentElement || triggerNode;
</script>

<template>
  <a-input
    v-if="projectType === 'backend'"
    :value="modelValue"
    placeholder="请输入后端服务部署根目录"
    @update:value="onBackendValueChange"
  >
    <template #addonAfter>
      <a-button
        type="link"
        size="small"
        :disabled="!currentServer"
        style="padding: 0 4px; height: auto"
        @click="emit('toggleExplorer')"
      >
        <component :is="isExplorerOpen ? FolderOpenFilled : FolderOpenOutlined" />
        {{ isExplorerOpen ? '收起' : '浏览' }}
      </a-button>
    </template>
  </a-input>
  <div v-else class="deploy-root-field">
    <a-auto-complete
      :value="modelValue"
      :options="options"
      :filter-option="filterOption"
      :get-popup-container="getPopupContainer"
      allow-clear
      placeholder="请选择服务器应用目录或输入绝对路径"
      @focus="handleFocus"
      @change="handleValueChange"
      @select="onSelect"
    >
      <template #suffixIcon>
        <LoadingOutlined v-if="loading" class="deploy-root-field__loading" spin />
      </template>
      <template #option="option">
        <div class="deploy-root-option" :class="{ 'is-disabled': option.disabled }">
          <div class="deploy-root-option__main">
            <span class="deploy-root-option__path">{{ option.value }}</span>
            <span class="deploy-root-option__section">{{ option.section }}</span>
          </div>
          <span class="deploy-root-option__description">{{ option.description }}</span>
        </div>
      </template>
    </a-auto-complete>
    <div v-if="hint" class="deploy-root-field__meta" :class="{ 'is-warning': warning }">
      <span class="deploy-root-field__hint">
        <BulbOutlined aria-hidden="true" />
        {{ hint }}
      </span>
      <a-button
        v-if="recommendation && !autoManaged && canApplyRecommendation"
        type="link"
        size="small"
        class="deploy-root-field__apply"
        @click="applyRecommendation"
      >
        使用推荐值
      </a-button>
      <a-button
        v-if="currentServer"
        type="link"
        size="small"
        class="deploy-root-field__apply"
        :class="{ 'is-active': isExplorerOpen }"
        @click="emit('toggleExplorer')"
      >
        <component :is="isExplorerOpen ? FolderOpenFilled : FolderOpenOutlined" />
        {{ isExplorerOpen ? '收起目录' : '浏览服务器' }}
      </a-button>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
