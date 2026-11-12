<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import Modal from 'ant-design-vue/es/modal';
import message from 'ant-design-vue/es/message';
import { YMonaco, YMonacoDiff } from 'virtual:yss-heavy-components';
import type { DeployTarget, NginxConfSaveOptions } from '@/api/deploy';
import NginxConfigHeaderBar from './components/NginxConfigHeaderBar/index.vue';
import NginxDiffToolbar from './components/NginxDiffToolbar/index.vue';
import NginxSyntaxErrorAlert from './components/NginxSyntaxErrorAlert/index.vue';
import NginxHistoryPopover from './components/NginxHistoryPopover/index.vue';
import NginxHistoryDiffView from './components/NginxHistoryDiffView/index.vue';
import NginxConfDownloadButton from './components/NginxConfDownloadButton/index.vue';
import NginxConfChangedModal from './components/NginxConfChangedModal/index.vue';
import { DEFAULT_MONACO_OPTIONS, DIFF_MONACO_OPTIONS } from './constant';
import { describeHistoryItem, describeSaveFailure, resolveRestoreHint, type NginxSaveFailureInfo } from './historyPolicy';
import { useNginxConfig, type NginxConfConflictDetails, type NginxConfSaveDone } from './hooks/useNginxConfig';
import { useNginxDiff } from './hooks/useNginxDiff';
import { useNginxHistory } from './hooks/useNginxHistory';
import { useNginxSyntaxDiagnostics } from './hooks/useNginxSyntaxDiagnostics';
import { useDrawerGuard } from './hooks/useDrawerGuard';

defineOptions({ name: 'NginxConfigDrawer' });

const props = defineProps<{
  targetId: number | null;
  target?: DeployTarget | null;
  /** 只读角色（viewer）：可查看、对比、下载，不能保存或恢复 */
  readonly?: boolean;
}>();
const emit = defineEmits<{
  (e: 'update:targetId', value: number | null): void;
  (
    e: 'save',
    targetId: number,
    content: string,
    done: NginxConfSaveDone,
    previousContent?: string,
    options?: NginxConfSaveOptions
  ): void;
}>();

/** 保存失败的阶段信息（校验失败已还原 / 重载失败已回滚 / 回滚失败） */
const saveFailure = shallowRef<NginxSaveFailureInfo | null>(null);
/** 409 冲突详情 */
const conflict = shallowRef<NginxConfConflictDetails | null>(null);
const conflictOpen = ref(false);

// 配置读取与保存 Hook
const {
  loading, saving, configPath, content, originalContent, encodingWarning, restoredLabel,
  isRawDirty, isSemanticDirty, canSave, handleSave, discardChanges, refreshBaseline, applyRestore,
} = useNginxConfig(props, emit, {
  onSaveError: (err) => {
    saveFailure.value = describeSaveFailure(err);
    handleSyntaxError(err);
  },
  onSaveSuccess: () => {
    clearSaveFeedback();
    void history.loadHistory();
  },
  onReset: () => clearSaveFeedback(),
  onConflict: (details) => {
    conflict.value = details;
    conflictOpen.value = true;
  },
});

// 差异对比与导航 Hook
const {
  diffMode, diffSummary, currentChangeIndex, totalChanges, actionTip,
  bindDiffEditor, toggleDiffMode, handleNextDiff, handlePrevDiff, handleRevertCurrentDiff, resetDiffState, getDiffEditor,
} = useNginxDiff(content, originalContent, isRawDirty, isSemanticDirty);

// 语法错误诊断与 Monaco 标注 Hook
const { syntaxError, bindSingleEditor, clearSyntaxError, handleSyntaxError, jumpToLine } =
  useNginxSyntaxDiagnostics(content, diffMode, getDiffEditor);

// 历史版本 Hook
const history = useNginxHistory(props);

/** 清除保存失败提示 */
function clearSaveFeedback() {
  saveFailure.value = null;
  clearSyntaxError();
}

/** 用户改动内容会清掉语法错误，这里同步清掉阶段信息 */
const visibleFailure = computed(() => (syntaxError.value ? saveFailure.value : null));

/** 底部提示：历史恢复后优先展示 */
const footerTip = computed(() => resolveRestoreHint(restoredLabel.value, isRawDirty.value) || actionTip.value);
const footerTipReady = computed(() => canSave.value);

/** 确认放弃未保存修改并重置状态 */
const handleDiscardAndReset = () => { discardChanges(); resetDiffState(); clearSaveFeedback(); };

/** 清理可能残留脱节在 body 上的全屏 DOM 节点 */
const cleanupFullscreenDom = () => {
  if (typeof document !== 'undefined') {
    document.querySelectorAll('.yss-monaco-wrapper.yss-monaco-fullscreen').forEach((el) => el.remove());
  }
};
onBeforeUnmount(cleanupFullscreenDom);

/** 执行抽屉关闭 */
const handleCloseDrawer = () => {
  cleanupFullscreenDom();
  clearSaveFeedback();
  history.resetHistory();
  conflictOpen.value = false;
  emit('update:targetId', null);
};

// 抽屉关闭拦截守卫 Hook
const { requestClose } = useDrawerGuard(isRawDirty, handleDiscardAndReset, handleCloseDrawer);
const open = computed(() => Boolean(props.targetId));

/** 刷新历史列表 */
const handleHistoryRefresh = () => { void history.loadHistory(); };

// 配置加载完成（拿到服务端解析的路径）后预取一次历史数量，按钮上直接显示「历史版本 (N)」
watch(configPath, (path) => {
  if (path) handleHistoryRefresh();
});

/** 执行恢复：载入编辑器并刷新基线 */
const doRestore = () => {
  const state = history.compare.value;
  if (!state || state.loading) return;
  const label = describeHistoryItem(state.item);
  const baselineChanged = applyRestore(
    state.historyContent,
    { content: state.currentContent, sha256: state.currentSha256 },
    { name: state.item.name, label }
  );
  history.exitCompare();
  resetDiffState();
  if (baselineChanged) {
    message.info('线上配置在你打开抽屉后已被修改，对比基线已更新为刚读取的线上内容');
  }
  message.success(`已载入${label}，确认无误后点击「保存并重载」`);
};

/** 恢复到编辑器：有未保存修改时二次确认 */
const handleRestore = () => {
  if (props.readonly) return;
  if (!isRawDirty.value) {
    doRestore();
    return;
  }
  Modal.confirm({
    title: '覆盖未保存的修改？',
    content: '编辑器里还有未保存的修改，载入历史版本会覆盖这些修改。',
    okText: '覆盖并载入',
    okButtonProps: { danger: true },
    cancelText: '取消',
    onOk: doRestore,
  });
};

/** 冲突：保留修改，把基线换成线上最新 */
const handleConflictKeepEditing = () => {
  if (!conflict.value) return;
  refreshBaseline(conflict.value.currentContent, conflict.value.currentSha256);
  conflictOpen.value = false;
  message.info('对比基线已更新为线上最新内容，你的修改仍保留在编辑器里');
};

/** 冲突：以线上最新为基线后直接再保存一次（覆盖） */
const handleConflictOverwrite = async () => {
  if (!conflict.value) return;
  refreshBaseline(conflict.value.currentContent, conflict.value.currentSha256);
  conflictOpen.value = false;
  await handleSave();
};
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
        <a-alert
          v-if="encodingWarning"
          type="warning"
          show-icon
          class="nginx-config-inline-alert"
          message="该配置文件不是 UTF-8 编码，部分字符（例如中文注释）可能显示为乱码，保存时会以 UTF-8 写回"
        />
        <a-alert
          v-if="readonly"
          type="info"
          show-icon
          class="nginx-config-inline-alert"
          message="当前账号为只读角色：可以查看、对比和下载配置，保存与恢复需要操作员权限"
        />
        <NginxSyntaxErrorAlert :error="syntaxError" :failure="visibleFailure" @jump-to-line="jumpToLine" @close="clearSaveFeedback" />
        <div class="nginx-config-editor-shell">
          <NginxHistoryDiffView
            v-if="history.compare.value"
            :item="history.compare.value.item"
            :history-content="history.compare.value.historyContent"
            :current-content="history.compare.value.currentContent"
            :current-fetched-at="history.compare.value.currentFetchedAt"
            :loading="history.compare.value.loading"
            :readonly="readonly"
            @restore="handleRestore"
            @exit="history.exitCompare"
            @refresh-current="history.refreshCurrent"
          />
          <template v-else>
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
            >
              <template #actions>
                <NginxHistoryPopover
                  v-model:open="history.historyOpen.value"
                  :items="history.items.value"
                  :loading="history.loading.value"
                  :loaded="history.loaded.value"
                  :error="history.error.value"
                  :keep="history.keep.value"
                  :truncated="history.truncated.value"
                  :downloading-name="history.downloadingName.value"
                  :disabled="loading || !configPath"
                  @refresh="handleHistoryRefresh"
                  @compare="history.openCompare"
                  @download="history.downloadItem"
                />
                <NginxConfDownloadButton
                  :config-path="configPath"
                  :online-content="originalContent"
                  :editing-content="content"
                  :dirty="isRawDirty"
                  :disabled="loading || !configPath"
                />
              </template>
            </NginxDiffToolbar>
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
                :options="readonly ? { ...DIFF_MONACO_OPTIONS, readOnly: true } : DIFF_MONACO_OPTIONS"
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
                :readonly="readonly"
                :toolbar-tooltip="false"
                :toolbar-options="{ copy: false, fullscreen: true }"
                :options="DEFAULT_MONACO_OPTIONS"
              />
            </div>
          </template>
        </div>
      </div>
    </a-spin>
    <template #footer>
      <div class="nginx-config-footer">
        <span :class="['nginx-config-action-tip', { 'is-ready': footerTipReady, 'is-restore': Boolean(restoredLabel) && isRawDirty }]">{{ footerTip }}</span>
        <a-space>
          <a-button @click="requestClose">关闭</a-button>
          <a-tooltip :title="readonly ? '只读角色不能保存配置' : ''">
            <a-button type="primary" :disabled="!canSave" :loading="saving" @click="handleSave">保存并重载</a-button>
          </a-tooltip>
        </a-space>
      </div>
    </template>
  </a-drawer>
  <NginxConfChangedModal
    v-model:open="conflictOpen"
    :path="conflict?.path || configPath"
    :latest-content="conflict?.currentContent || ''"
    :my-content="content"
    :loading="saving"
    @keep-editing="handleConflictKeepEditing"
    @overwrite="handleConflictOverwrite"
  />
</template>

<style scoped lang="less">
@import './style.less';
</style>
