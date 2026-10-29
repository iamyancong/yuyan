import { computed, nextTick, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import { openExternal } from '@/utils/open';
import {
  DEPLOY_FAILURE_BRIEF,
  formatDeployDateTime,
  getDeployProgressFailureStageKey,
  getDeployProgressFailureTitle,
  publishStages,
  UNKNOWN_OPERATOR_TEXT,
  UPLOAD_STRATEGY_LABEL_MAP,
} from '../../../constant';
import { calcStageStatus, getLogText, type PublishConfirmModalProps } from '../constant';
import { extractErrorSummaryFromLogs, formatEditorDiagnosticBanner } from '../../RecordLogDrawer/constant';
import type { DeployErrorSummary } from '@/api/deploy';
import { formatDeployDuration, resolveRuntimeLockState } from '../../../hooks/runtimeLockPolicy';
import { useDeployLogHints } from '../../../hooks/useDeployLogHints';
import { isDeployFailureEvent } from '../../../logPresentation';

/** YMonaco 日志模式暴露方法 */
interface MonacoLogViewerExpose {
  scrollToBottom: () => void;
  layout?: () => void;
  getInstance?: () => any;
  editor?: any;
}

/**
 * 发布确认与进度展示逻辑 Hook
 * @param props 组件属性
 */
export function usePublishConfirm(props: PublishConfirmModalProps) {
  /** 发布日志 Monaco 实例引用 */
  const logMonacoRef = ref<MonacoLogViewerExpose | null>(null);

  /** 白话提示开关（跨抽屉共享） */
  const { showLogHints } = useDeployLogHints();

  /** 当前展示的操作人/发布人 */
  const displayOperator = computed(() => {
    const directOperator = String(props.operator || '').trim();
    if (directOperator) return directOperator;
    if (!props.started) {
      return String(props.currentUserName || '').trim() || UNKNOWN_OPERATOR_TEXT;
    }
    return UNKNOWN_OPERATOR_TEXT;
  });

  /** 是否为当前用户发起 */
  const isSelfOperator = computed(() => {
    const current = String(props.currentUserName || '').trim();
    return Boolean(current && displayOperator.value === current);
  });

  /** 顶部 Header 发起人文案 */
  const operatorTagText = computed(() => {
    if (!props.started) {
      return `拟发布人：${displayOperator.value}`;
    }
    if (isSelfOperator.value) {
      return `${displayOperator.value} (我) 发起`;
    }
    return `${displayOperator.value} 发起`;
  });

  /** 格式化发起时间 */
  const displayStartedAt = computed(() => {
    if (!props.started) return '等待开始';
    return props.startedAt ? formatDeployDateTime(props.startedAt) : '-';
  });

  /** 当前发布分支 */
  const branchText = computed(() => props.target?.defaultBranch || 'dev');

  /** 是否已进入结束态 */
  const finished = computed(() => props.started && !props.running && !props.resultUnconfirmed && props.logs.some((item) => item.type === 'result') && !props.stopped);

  /** 是否发布失败 */
  // 工具原始输出的 error 行（可能被自动重试兜住）不代表发布失败，只看雨燕系统判定的错误（#46）
  const hasError = computed(() => props.logs.some((item) => isDeployFailureEvent(item)));

  /** 当前可见发布节点 */
  const visibleStages = computed(() => publishStages.filter((stage) => !stage.nginxOption || Boolean(props.target?.[stage.nginxOption])));

  /** 当前阶段标识 */
  const currentStageKey = computed(() => {
    const failureStageKey = hasError.value ? getDeployProgressFailureStageKey(props.logs) : '';
    if (failureStageKey) return failureStageKey;
    const stageEvent = [...props.logs].reverse().find((item) => item.type === 'stage');
    if (stageEvent?.type === 'stage') return stageEvent.stage;
    if (props.percent >= 100) return 'finish';
    return props.started ? 'validate' : '';
  });

  /** 当前阶段名称 */
  const currentStageTitle = computed(() => visibleStages.value.find((stage) => stage.key === currentStageKey.value)?.title || '');

  /** 当前失败标题 */
  const failureTitle = computed(() =>
    getDeployProgressFailureTitle({
      action: 'deploy',
      events: props.logs,
      fallbackStage: currentStageKey.value,
    })
  );

  /** 顶部右侧状态文案 */
  const statusText = computed(() => {
    if (props.resultUnconfirmed) return '结果待确认';
    if (props.stopped) return '已停止';
    if (hasError.value) return failureTitle.value;
    if (finished.value) return '发布完成';
    return props.started ? '执行中' : '待确认';
  });

  /** 顶部状态说明 */
  const headerDescription = computed(() => {
    if (props.resultUnconfirmed) return props.detail;
    if (!props.started) return '请核对目标信息，点击开始发布后将拉取代码、构建产物、备份目录并重载 Nginx。';
    if (props.stopped) return '发布任务已停止，未进入上传产物阶段。';
    if (hasError.value) {
      return currentStageTitle.value ? `${currentStageTitle.value}阶段执行失败，${DEPLOY_FAILURE_BRIEF}` : DEPLOY_FAILURE_BRIEF;
    }
    return props.detail || '正在等待发布进度回传';
  });

  /** 协同锁与停止权限策略计算 */
  const runtimeLockState = computed(() =>
    resolveRuntimeLockState({
      currentUserName: props.currentUserName,
      userRole: props.userRole,
      taskOperator: displayOperator.value,
      startedAt: props.startedAt,
      running: props.running,
      stoppable: props.stoppable,
      action: 'deploy',
      currentStage: currentStageKey.value,
    })
  );

  const isSubscriberMode = computed(() => runtimeLockState.value.isSubscriberMode);
  const canStop = computed(() => runtimeLockState.value.canStop);
  const canPreempt = computed(() => runtimeLockState.value.canPreempt);
  const isAdmin = computed(() => runtimeLockState.value.isAdmin);
  const stopButtonText = computed(() => runtimeLockState.value.stopButtonText);
  const stopButtonTooltip = computed(() => runtimeLockState.value.stopButtonTooltip);
  const lockDescription = computed(() => runtimeLockState.value.lockDescription);

  /** 顶部状态样式 */
  const statusClassName = computed(() => {
    if (props.stopped) return 'is-stopped';
    if (hasError.value) return 'is-error';
    if (finished.value) return 'is-success';
    if (props.started) return 'is-running';
    return 'is-ready';
  });

  /** 目标信息摘要 */
  const targetSummaries = computed(() => [
    { label: '项目', value: props.target?.projectName || '-' },
    { label: '分支', value: branchText.value },
    { label: '发布人', value: isSelfOperator.value ? `${displayOperator.value} (我)` : displayOperator.value },
    { label: '服务器', value: props.target?.serverName || '-' },
    { label: '部署根目录', value: props.target?.deployRoot || '-' },
    { label: '上传策略', value: props.target?.uploadStrategy ? UPLOAD_STRATEGY_LABEL_MAP[props.target.uploadStrategy] : UPLOAD_STRATEGY_LABEL_MAP.overlayKeepAssets },
    { label: '访问地址', value: props.target?.visitUrl || '未配置' },
    { label: '发起时间', value: displayStartedAt.value },
  ]);

  /** 发布日志文本（构建/发布失败时在末尾拼接高对比度终端诊断报告，并去重流式结束时的重复错误事件） */
  const publishLogContent = computed(() => {
    if (!props.logs.length) return '暂无发布日志';
    const seenErrorMessages = new Set<string>();
    const deduplicatedLogs = props.logs.filter((item) => {
      if (item.type === 'log' && item.level === 'error' && item.message) {
        seenErrorMessages.add(item.message.trim());
        return true;
      }
      if (item.type === 'error' && item.message && seenErrorMessages.has(item.message.trim())) {
        return false;
      }
      return true;
    });
    const baseContent = deduplicatedLogs
      .map((item) => getLogText(item, props.target?.projectName, showLogHints.value))
      .join('\n');
    // 如果发布失败且识别到核心错误根因，直接在 Monaco 编辑器末尾呈现 ASCII 终端高亮诊断报告
    if (hasError.value && errorSummary.value) {
      const banner = formatEditorDiagnosticBanner(errorSummary.value);
      return `${baseContent}\n${banner}`;
    }
    return baseContent;
  });

  /** 获取节点状态 */
  const getStageStatus = (stage: any) => {
    return calcStageStatus({
      stage,
      stopped: props.stopped,
      hasError: hasError.value,
      started: props.started,
      running: props.running,
      percent: props.percent,
      currentStageKey: currentStageKey.value,
    });
  };

  /**
   * 获取节点展示文案。
   * @param stage 发布节点
   * @returns 节点文案
   */
  const getStageLabel = (stage: any) => {
    return getStageStatus(stage) === 'error' ? `${stage.title}失败` : stage.title;
  };

  /** 是否发布成功并已就绪 */
  const isSuccessFinished = computed(() => finished.value && !hasError.value && !props.stopped);

  /** 是否有可用的有效站点访问 URL */
  const hasValidVisitUrl = computed(() => {
    const url = String(props.target?.visitUrl || '').trim();
    if (!url || url === '未配置' || url === '-') return false;
    return /^https?:\/\//i.test(url);
  });

  /** 成功耗时文案 */
  const successDurationText = computed(() => {
    if (!isSuccessFinished.value || !props.startedAt) return '';
    return formatDeployDuration(props.startedAt, new Date().toISOString());
  });

  /** 成功版本文案 */
  const successVersionText = computed(() => branchText.value);

  /** 打开访问站点 */
  const openSite = async () => {
    const url = props.target?.visitUrl;
    if (!url) return;
    await openExternal(url);
  };

  /** 复制站点访问地址 */
  const copySiteUrl = async () => {
    const url = props.target?.visitUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      message.success('访问地址已复制');
    } catch {
      message.error('复制失败');
    }
  };

  /** 滚动日志到底部 */
  const scrollLogsToBottom = async () => {
    await nextTick();
    window.requestAnimationFrame(() => {
      logMonacoRef.value?.scrollToBottom();
      window.setTimeout(() => {
        logMonacoRef.value?.scrollToBottom();
      }, 80);
    });
  };

  watch(() => props.logs.length, scrollLogsToBottom);
  watch(
    () => props.open,
    (open) => {
      if (open) void scrollLogsToBottom();
    }
  );

  /** 错误根因诊断信息 */
  const errorSummary = computed<DeployErrorSummary | null>(() => {
    if (!hasError.value) return null;
    const errorEvent = props.logs.find((e) => e.type === 'error' && (e as any).errorSummary);
    if ((errorEvent as any)?.errorSummary) {
      return (errorEvent as any).errorSummary;
    }
    const logItems = props.logs
      .filter((e) => e.type === 'log' || e.type === 'error')
      .map((e) => ({
        level: (e.type === 'error' ? 'error' : (e as any).level || 'info') as any,
        message: (e as any).message || '',
        stage: e.stage || '',
        timestamp: e.timestamp || '',
      }));
    return extractErrorSummaryFromLogs(logItems);
  });

  /** 定位至错误根因或底部的诊断报告 */
  const jumpToErrorLine = async () => {
    if (!errorSummary.value) return;
    await nextTick();
    const expose = logMonacoRef.value;
    const rawEditor = typeof expose?.getInstance === 'function' ? expose.getInstance() : (expose as any)?.editor;
    if (rawEditor) {
      const lineCount = rawEditor.getModel?.()?.getLineCount() || 99999;
      // 定位到诊断报告标题位置（通常位于末尾倒数 16 行左右）
      const targetLine = Math.max(1, lineCount - 16);
      rawEditor.revealLineInCenter?.(targetLine);
      rawEditor.setPosition?.({ lineNumber: targetLine, column: 1 });
      rawEditor.focus?.();
    }
  };

  return {
    logMonacoRef,
    finished,
    hasError,
    errorSummary,
    jumpToErrorLine,
    isSuccessFinished,
    hasValidVisitUrl,
    successDurationText,
    successVersionText,
    openSite,
    copySiteUrl,
    visibleStages,
    headerDescription,
    statusText,
    statusClassName,
    targetSummaries,
    displayOperator,
    isSelfOperator,
    operatorTagText,
    displayStartedAt,
    isSubscriberMode,
    canStop,
    canPreempt,
    isAdmin,
    stopButtonText,
    stopButtonTooltip,
    lockDescription,
    publishLogContent,
    getStageStatus,
    getStageLabel,
    scrollLogsToBottom,
  };
}
