import { computed, nextTick, ref, watch } from 'vue';
import { DEPLOY_FAILURE_BRIEF, getDeployProgressFailureStageKey, getDeployProgressFailureTitle, publishStages, UPLOAD_STRATEGY_LABEL_MAP } from '../../../constant';
import { calcStageStatus, getLogText, type PublishConfirmModalProps } from '../constant';

/** YMonaco 日志模式暴露方法 */
interface MonacoLogViewerExpose {
  scrollToBottom: () => void;
}

/**
 * 发布确认与进度展示逻辑 Hook
 * @param props 组件属性
 */
export function usePublishConfirm(props: PublishConfirmModalProps) {
  /** 发布日志 Monaco 实例引用 */
  const logMonacoRef = ref<MonacoLogViewerExpose | null>(null);

  /** 当前发布分支 */
  const branchText = computed(() => props.target?.defaultBranch || 'dev');

  /** 是否已进入结束态 */
  const finished = computed(() => props.started && !props.running && props.logs.length > 0 && !props.stopped);

  /** 是否发布失败 */
  const hasError = computed(() => props.logs.some((item) => item.type === 'error' || (item.type === 'log' && item.level === 'error')));

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
    if (props.stopped) return '已停止';
    if (hasError.value) return failureTitle.value;
    if (finished.value) return '发布完成';
    return props.started ? '执行中' : '待确认';
  });

  /** 顶部状态说明 */
  const headerDescription = computed(() => {
    if (!props.started) return '请核对目标信息，点击开始发布后将拉取代码、构建产物、备份目录并重载 Nginx。';
    if (props.stopped) return '发布任务已停止，未进入上传产物阶段。';
    if (hasError.value) {
      return currentStageTitle.value ? `${currentStageTitle.value}阶段执行失败，${DEPLOY_FAILURE_BRIEF}` : DEPLOY_FAILURE_BRIEF;
    }
    return props.detail || '正在等待发布进度回传';
  });

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
    { label: '服务器', value: props.target?.serverName || '-' },
    { label: '部署根目录', value: props.target?.deployRoot || '-' },
    { label: '上传策略', value: props.target?.uploadStrategy ? UPLOAD_STRATEGY_LABEL_MAP[props.target.uploadStrategy] : UPLOAD_STRATEGY_LABEL_MAP.cleanReplace },
    { label: '访问地址', value: props.target?.visitUrl || '未配置' },
    // { label: '环境', value: props.target?.envName || '测试' },
  ]);

  /** 发布日志文本 */
  const publishLogContent = computed(() => {
    if (!props.logs.length) return '暂无发布日志';
    return props.logs.map((item) => getLogText(item, props.target?.projectName)).join('\n');
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

  return {
    logMonacoRef,
    finished,
    hasError,
    visibleStages,
    headerDescription,
    statusText,
    statusClassName,
    targetSummaries,
    publishLogContent,
    getStageStatus,
    getStageLabel,
    scrollLogsToBottom,
  };
}
