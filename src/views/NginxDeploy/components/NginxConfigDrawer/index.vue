<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue';
import { YMonaco, YMonacoDiff } from 'virtual:yss-heavy-components';
import type { DeployTarget } from '@/api/deploy';
import NginxConfigHeaderBar from './components/NginxConfigHeaderBar/index.vue';
import NginxDiffToolbar from './components/NginxDiffToolbar/index.vue';
import NginxSyntaxErrorAlert from './components/NginxSyntaxErrorAlert/index.vue';
import { DEFAULT_MONACO_OPTIONS, DIFF_MONACO_OPTIONS } from './constant';
import { useNginxConfig } from './hooks/useNginxConfig';
import { useNginxDiff } from './hooks/useNginxDiff';
import { useNginxSyntaxDiagnostics } from './hooks/useNginxSyntaxDiagnostics';
import { useDrawerGuard } from './hooks/useDrawerGuard';

defineOptions({ name: 'NginxConfigDrawer' });

const props = defineProps<{ targetId: number | null; target?: DeployTarget | null }>();
const emit = defineEmits<{
  (e: 'update:targetId', value: number | null): void;
  (e: 'save', targetId: number, content: string, done: (error?: unknown) => void): void;
}>();

// 配置读取与保存 Hook
const { loading, saving, configPath, content, originalContent, isRawDirty, isSemanticDirty, canSave, handleSave, discardChanges } =
  useNginxConfig(props, emit, {
    onSaveError: (err) => handleSyntaxError(err),
    onSaveSuccess: () => clearSyntaxError(),
    onReset: () => clearSyntaxError(),
  });

// 差异对比与导航 Hook
const {
  diffMode, diffSummary, currentChangeIndex, totalChanges, actionTip,
  bindDiffEditor, toggleDiffMode, handleNextDiff, handlePrevDiff, handleRevertCurrentDiff, resetDiffState, getDiffEditor,
} = useNginxDiff(content, originalContent, isRawDirty, isSemanticDirty);

// 语法错误诊断与 Monaco 标注 Hook
const { syntaxError, bindSingleEditor, clearSyntaxError, handleSyntaxError, jumpToLine } =
  useNginxSyntaxDiagnostics(content, diffMode, getDiffEditor);

/** 确认放弃未保存修改并重置状态 */
const handleDiscardAndReset = () => { discardChanges(); resetDiffState(); clearSyntaxError(); };

/** 清理可能残留脱节在 body 上的全屏 DOM 节点 */
const cleanupFullscreenDom = () => {
  if (typeof document !== 'undefined') {
    document.querySelectorAll('.yss-monaco-wrapper.yss-monaco-fullscreen').forEach((el) => el.remove());
  }
};
onBeforeUnmount(cleanupFullscreenDom);

/** 执行抽屉关闭 */
const handleCloseDrawer = () => { cleanupFullscreenDom(); clearSyntaxError(); emit('update:targetId', null); };

// 抽屉关闭拦截守卫 Hook
const { requestClose } = useDrawerGuard(isRawDirty, handleDiscardAndReset, handleCloseDrawer);
const open = computed(() => Boolean(props.targetId));
</script>

<template>
  <a-drawer
    :open="open"
    @close="requestClose"
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
        <NginxSyntaxErrorAlert :error="syntaxError" @jump-to-line="jumpToLine" @close="clearSyntaxError" />
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
            @revert-diff="handleRevertCurrentDiff"
          />
          <div class="nginx-config-editor-content">
            <YMonacoDiff
              v-if="diffMode"
              :ref="bindDiffEditor"
              :original="originalContent"
              v-model:value="content"
              language="nginx"
              theme="vs-dark"
              height="100%"
              :auto-layout="true"
              :format-on-mount="false"
              :toolbar-tooltip="false"
              :toolbar-options="{ copy: false, fullscreen: true }"
              :options="DIFF_MONACO_OPTIONS"
            />
            <YMonaco
              v-else
              :ref="bindSingleEditor"
              v-model:modelValue="content"
              language="nginx"
              theme="vs-dark"
              height="100%"
              :auto-layout="true"
              :format-on-mount="false"
              :toolbar-tooltip="false"
              :toolbar-options="{ copy: false, fullscreen: true }"
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
