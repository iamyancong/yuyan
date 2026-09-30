import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import {
  calcMonacoLineChangesSummary,
  calcSimpleTextDiffSummary,
  formatDiffSummary,
  NGINX_ACTION_TIPS,
  type DiffSummary,
} from '../constant';

/**
 * Nginx 配置 Diff 对比与导航 Hook
 * @param content 当前编辑内容 Ref
 * @param originalContent 远端基线内容 Ref
 * @param isRawDirty 原始文本变动标识 Ref
 * @param isSemanticDirty 语义实质变动标识 Ref
 */
export function useNginxDiff(
  content: Ref<string>,
  originalContent: Ref<string>,
  isRawDirty: Ref<boolean>,
  isSemanticDirty: Ref<boolean>
) {
  /** 对比模式开关状态（默认 OFF） */
  const diffMode = ref(false);

  /** 差异摘要统计 */
  const diffSummary = ref<DiffSummary>({ changeCount: 0, addedLines: 0, removedLines: 0 });

  /** 当前定位的差异索引（从 1 开始，0 表示未聚焦） */
  const currentChangeIndex = ref(0);

  /** 差异总处数 */
  const totalChanges = computed(() => diffSummary.value.changeCount);

  /** Monaco DiffEditor 原生实例引用 */
  const diffEditorInstance = shallowRef<any>(null);

  /** 实例获取轮询定时器 */
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** diffEditor 监听解绑回调 */
  let diffListenerDispose: (() => void) | null = null;

  /** 清理轮询定时器 */
  const clearPollTimer = () => {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };

  /** 清理编辑器监听 */
  const clearEditorListener = () => {
    if (diffListenerDispose) {
      diffListenerDispose();
      diffListenerDispose = null;
    }
  };

  /** 更新 Monaco DiffEditor 中的行差异统计 */
  const updateLineChangesFromEditor = () => {
    if (!diffEditorInstance.value) return;
    try {
      const lineChanges = diffEditorInstance.value.getLineChanges?.();
      if (Array.isArray(lineChanges) && lineChanges.length > 0) {
        diffSummary.value = calcMonacoLineChangesSummary(lineChanges);
        if (currentChangeIndex.value === 0 || currentChangeIndex.value > lineChanges.length) {
          currentChangeIndex.value = 1;
        }
      } else {
        // Monaco 正在异步计算或为空，通过文本算法兜底
        const fallback = calcSimpleTextDiffSummary(originalContent.value, content.value);
        diffSummary.value = fallback;
        currentChangeIndex.value = fallback.changeCount > 0 ? 1 : 0;
      }
    } catch {
      diffSummary.value = calcSimpleTextDiffSummary(originalContent.value, content.value);
    }
  };

  /** 挂载原生 Monaco DiffEditor 实例与监听 */
  const attachEditorInstance = (rawEditor: any) => {
    diffEditorInstance.value = rawEditor;
    clearEditorListener();

    if (typeof rawEditor?.onDidUpdateDiff === 'function') {
      const disposable = rawEditor.onDidUpdateDiff(() => {
        updateLineChangesFromEditor();
      });
      diffListenerDispose = () => {
        if (typeof disposable?.dispose === 'function') {
          disposable.dispose();
        }
      };
    }
    updateLineChangesFromEditor();
  };

  /** 绑定 Monaco DiffEditor 实例（支持异步实例化短轮询） */
  const bindDiffEditor = (instance: any) => {
    clearPollTimer();

    if (!instance) {
      clearEditorListener();
      diffEditorInstance.value = null;
      return;
    }

    const rawEditor = typeof instance.getInstance === 'function' ? instance.getInstance() : instance;
    if (rawEditor) {
      attachEditorInstance(rawEditor);
      return;
    }

    // 实例处于异步创建中，进行短轮询检测直至实例就绪
    let attempts = 0;
    const poll = () => {
      attempts++;
      const editor = typeof instance.getInstance === 'function' ? instance.getInstance() : null;
      if (editor) {
        attachEditorInstance(editor);
      } else if (attempts < 30) {
        pollTimer = setTimeout(poll, 50);
      }
    };
    pollTimer = setTimeout(poll, 50);
  };

  /** 切换对比模式 */
  const toggleDiffMode = (val?: boolean) => {
    if (typeof val === 'boolean') {
      diffMode.value = val;
    } else {
      diffMode.value = !diffMode.value;
    }
  };

  /** 跳转至下一处变更 */
  const handleNextDiff = () => {
    if (!diffEditorInstance.value?.goToDiff) return;
    diffEditorInstance.value.goToDiff('next');
    if (totalChanges.value > 0) {
      currentChangeIndex.value = (currentChangeIndex.value % totalChanges.value) + 1;
    }
  };

  /** 跳转至上一处变更 */
  const handlePrevDiff = () => {
    if (!diffEditorInstance.value?.goToDiff) return;
    diffEditorInstance.value.goToDiff('previous');
    if (totalChanges.value > 0) {
      currentChangeIndex.value =
        currentChangeIndex.value <= 1 ? totalChanges.value : currentChangeIndex.value - 1;
    }
  };

  /** 重置 Diff 状态 */
  const resetDiffState = () => {
    clearPollTimer();
    clearEditorListener();
    diffMode.value = false;
    currentChangeIndex.value = 0;
    diffSummary.value = { changeCount: 0, addedLines: 0, removedLines: 0 };
    diffEditorInstance.value = null;
  };

  /** 监听内容与基线变化，实时更新差异摘要 */
  watch(
    [content, originalContent, diffMode],
    ([curr, orig, isDiff]) => {
      if (!isDiff || !diffEditorInstance.value) {
        diffSummary.value = calcSimpleTextDiffSummary(orig, curr);
        currentChangeIndex.value = diffSummary.value.changeCount > 0 ? 1 : 0;
      }
    },
    { immediate: true }
  );

  /** 当变回 clean 态时，自动关闭 Diff 模式 */
  watch(isRawDirty, (dirty) => {
    if (!dirty) {
      resetDiffState();
    }
  });

  onScopeDispose(() => {
    clearPollTimer();
    clearEditorListener();
  });

  /** 底部操作提示文案 */
  const actionTip = computed(() => {
    if (!isRawDirty.value) {
      return NGINX_ACTION_TIPS.CLEAN;
    }
    if (!isSemanticDirty.value) {
      return NGINX_ACTION_TIPS.NO_SEMANTIC_CHANGE;
    }
    const summaryText = formatDiffSummary(diffSummary.value);
    if (diffMode.value) {
      return summaryText ? `${NGINX_ACTION_TIPS.DIFF_ACTIVE} · ${summaryText}` : NGINX_ACTION_TIPS.DIFF_ACTIVE;
    }
    return summaryText ? `配置已修改 · ${summaryText}` : NGINX_ACTION_TIPS.DIRTY_EDIT;
  });

  return {
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
  };
}
