<script setup lang="ts">
import { computed } from 'vue';
import { YMonaco, YMonacoDiff } from 'virtual:yss-heavy-components';
import type { DeployTarget } from '@/api/deploy';
import NginxConfigHeaderBar from './components/NginxConfigHeaderBar/index.vue';
import NginxDiffToolbar from './components/NginxDiffToolbar/index.vue';
import { DEFAULT_MONACO_OPTIONS, DIFF_MONACO_OPTIONS } from './constant';
import { useNginxConfig } from './hooks/useNginxConfig';
import { useNginxDiff } from './hooks/useNginxDiff';
import { useDrawerGuard } from './hooks/useDrawerGuard';

defineOptions({ name: 'NginxConfigDrawer' });

/** 属性定义 */
const props = defineProps<{
  targetId: number | null;
  target?: DeployTarget | null;
}>();

/** 事件定义 */
const emit = defineEmits<{
  (e: 'update:targetId', value: number | null): void;
  (e: 'save', targetId: number, content: string, done: (error?: unknown) => void): void;
}>();

// 配置读取与保存 Hook
const {
  loading,
  saving,
  configPath,
  content,
  originalContent,
  isRawDirty,
  isSemanticDirty,
  canSave,
  handleSave,
  discardChanges,
} = useNginxConfig(props, emit);

// 差异对比与导航 Hook
const {
  diffMode,
  diffSummary,
  currentChangeIndex,
  totalChanges,
  actionTip,
  bindDiffEditor,
  toggleDiffMode,
  handleNextDiff,
  handlePrevDiff,
  resetDiffState,
} = useNginxDiff(content, originalContent, isRawDirty, isSemanticDirty);

/** 确认放弃未保存修改并重置状态 */
const handleDiscardAndReset = () => {
  discardChanges();
  resetDiffState();
};

/** 执行抽屉关闭 */
const handleCloseDrawer = () => {
  emit('update:targetId', null);
};

// 抽屉关闭拦截守卫 Hook
const { requestClose } = useDrawerGuard(isRawDirty, handleDiscardAndReset, handleCloseDrawer);

/** 抽屉打开受控状态 */
const open = computed({
  get: () => Boolean(props.targetId),
  set: (value) => {
    if (!value) requestClose();
  },
});
</script>

<template>
  <a-drawer
    v-model:open="open"
    width="75%"
    placement="right"
    title="Nginx 配置文件管理"
    destroy-on-close
    :mask-closable="false"
    root-class-name="nginx-config-drawer-root"
    :body-style="{ padding: '16px' }"
  >
    <a-spin :spinning="loading">
      <div class="nginx-config-drawer-body">
        <NginxConfigHeaderBar :target="target" :config-path="configPath" />
        <div class="nginx-config-editor-shell">
          <NginxDiffToolbar
            :is-dirty="isRawDirty"
            :diff-mode="diffMode"
            :diff-summary="diffSummary"
            :current-change-index="currentChangeIndex"
            :total-changes="totalChanges"
            :content="content"
            @toggle-diff="toggleDiffMode"
            @next-diff="handleNextDiff"
            @prev-diff="handlePrevDiff"
          />
          <div class="nginx-config-editor-content">
            <!-- 对比模式：side-by-side 差异编辑器（左侧只读基线，右侧可编辑/还原块） -->
            <YMonacoDiff
              v-if="diffMode"
              :ref="bindDiffEditor"
              :original="originalContent"
              v-model:value="content"
              language="nginx"
              theme="vs-dark"
              height="calc(100vh - 238px)"
              :format-on-mount="false"
              :options="DIFF_MONACO_OPTIONS"
            />
            <!-- 默认态：普通单栏可编辑 Monaco -->
            <YMonaco
              v-else
              v-model:modelValue="content"
              language="nginx"
              theme="vs-dark"
              height="calc(100vh - 238px)"
              :format-on-mount="false"
              :options="DEFAULT_MONACO_OPTIONS"
            />
          </div>
        </div>
      </div>
    </a-spin>
    <template #footer>
      <div class="nginx-config-footer">
        <span :class="['nginx-config-action-tip', { 'is-ready': canSave }]">{{ actionTip }}</span>
        <a-space>
          <a-button @click="requestClose">关闭</a-button>
          <a-button type="primary" :disabled="!canSave" :loading="saving" @click="handleSave">保存并重载</a-button>
        </a-space>
      </div>
    </template>
  </a-drawer>
</template>

<style scoped lang="less">
@import './style.less';
</style>
