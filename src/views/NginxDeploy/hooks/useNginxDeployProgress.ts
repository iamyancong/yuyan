import { computed, reactive, ref, watch, type Ref } from 'vue';
import message from 'ant-design-vue/es/message';
import {
  deployTargetWithProgress,
  getTargetDeployProgress,
  rollbackRecordWithProgress,
  stopTargetDeploy,
  subscribeTargetDeployProgress,
  undoRollbackRecordWithProgress,
  type DeployProgressEvent,
  type DeployProgressSnapshot,
  type DeployRecord,
  type DeployTarget,
} from '@/api/deploy';
import { DEPLOY_FAILURE_BRIEF, getDeployProgressActionLabel, getDeployProgressFailureTitle, getDeployProgressStageLabel } from '../constant';
import type { DeployProgressMode, RefreshActiveTabOptions } from '../types';
import { getErrorMessage, isAbortError, isDeployConflictError, isNotFoundError } from '../utils';

/** 发布停止前允许中断的阶段 */
const STOPPABLE_PUBLISH_STAGE_KEYS = new Set(['validate', 'clone', 'install', 'build']);

import { useNginxDeployContext } from './useNginxDeployContext';

/** 发布进度 Hook 参数 */
interface UseNginxDeployProgressParams {
  ensureLoggedIn?: () => boolean;
  refreshActiveTab?: (options?: RefreshActiveTabOptions) => Promise<void>;
  authState?: Readonly<Ref<{ token?: string | null }>>;
  userName?: Ref<string>;
  activeRecord?: Ref<DeployRecord | null>;
  setTargetRuntimeSnapshot?: (snapshot: DeployProgressSnapshot) => void;
  clearTargetRuntimeSnapshot?: (targetId: number) => void;
}

/** 发布启动选项 */
interface StartPublishOptions {
  /** 是否强制重新安装依赖 */
  forceInstallDependencies?: boolean;
}

/**
 * 管理发布、订阅运行中发布、停止发布、回滚和撤销回滚进度。
 * @description 支持零传参的依赖注入，解耦原本扁平化的数据传递网络。
 * @param params 可选的认证、刷新和当前记录依赖
 * @returns 发布进度状态和操作方法
 */
export function useNginxDeployProgress(params?: UseNginxDeployProgressParams) {
  const fallbackContext = useNginxDeployContext;
  const getContext = () => {
    try {
      return fallbackContext();
    } catch {
      return null;
    }
  };
  const context = getContext();

  const ensureLoggedIn = params?.ensureLoggedIn ?? context?.ensureLoggedIn!;
  const refreshActiveTab = params?.refreshActiveTab ?? context?.refreshActiveTab!;
  const authState = params?.authState ?? context?.authState!;
  const userName = params?.userName ?? context?.userName!;
  const activeRecord = params?.activeRecord ?? context?.activeRecord!;
  const setTargetRuntimeSnapshot = params?.setTargetRuntimeSnapshot ?? context?.setTargetRuntimeSnapshot!;
  const clearTargetRuntimeSnapshot = params?.clearTargetRuntimeSnapshot ?? context?.clearTargetRuntimeSnapshot!;
  const rollbackProgressOpen = ref(false);
  const publishConfirmOpen = ref(false);
  const publishStarted = ref(false);
  const progressMode = ref<DeployProgressMode>('deploy');
  const activePublishTarget = ref<DeployTarget | null>(null);
  const publishStopping = ref(false);
  let deployAbortController: AbortController | null = null;
  let progressSessionId = 0;

  const progressState = reactive({
    percent: 0,
    title: '',
    detail: '',
    logs: [] as DeployProgressEvent[],
    running: false,
    stopped: false,
  });

  /** 当前发布阶段 */
  const currentPublishStageKey = computed(() => {
    const stageEvent = [...progressState.logs].reverse().find((item) => item.type === 'stage');
    if (stageEvent?.type === 'stage') return stageEvent.stage;
    return progressState.running ? 'validate' : '';
  });

  /** 当前发布是否允许停止 */
  const publishStoppable = computed(() => {
    return progressMode.value === 'deploy' && progressState.running && STOPPABLE_PUBLISH_STAGE_KEYS.has(currentPublishStageKey.value);
  });

  /** 恢复类操作进度弹窗标题 */
  const rollbackProgressTitle = computed(() => {
    return progressMode.value === 'undoRollback' ? '撤销回滚进度' : '回滚进度';
  });

  /**
   * 追加进度错误日志，避免流式错误事件和 catch 分支重复写入同一条错误。
   * @param errorMessage 错误消息
   * @param stage 失败阶段
   */
  const appendProgressErrorLog = (errorMessage: string, stage?: string) => {
    const lastLog = progressState.logs[progressState.logs.length - 1];
    if (lastLog?.type === 'error' && lastLog.message === errorMessage) return;
    progressState.logs.push({ type: 'error', stage, message: errorMessage, timestamp: new Date().toISOString() });
  };

  /** 追加发布停止日志 */
  const appendProgressStoppedLog = () => {
    const lastLog = progressState.logs[progressState.logs.length - 1];
    if (lastLog?.type === 'log' && lastLog.stage === 'cancel') return;
    progressState.logs.push({
      type: 'log',
      level: 'warn',
      stage: 'cancel',
      message: '用户已停止发布任务',
      timestamp: new Date().toISOString(),
    });
  };

  /** 重置发布进度 */
  const resetPublishProgress = () => {
    Object.assign(progressState, { percent: 0, title: '', detail: '', logs: [], running: false, stopped: false });
  };

  /** 重置发布工作台临时态 */
  const resetPublishWorkbench = () => {
    activePublishTarget.value = null;
    publishStarted.value = false;
    resetPublishProgress();
  };

  /**
   * 断开当前页面对发布进度流的订阅，不停止后端发布任务。
   */
  const detachPublishProgressStream = () => {
    progressSessionId += 1;
    if (deployAbortController) {
      deployAbortController.abort();
      deployAbortController = null;
    }
    publishStopping.value = false;
  };

  /**
   * 判断进度日志中是否已经存在相同事件，避免快照恢复和流式订阅重复写入历史事件。
   * @param event 进度事件
   * @returns 是否已存在
   */
  const hasProgressEvent = (event: DeployProgressEvent) => {
    return progressState.logs.some((item) => {
      if (item.timestamp !== event.timestamp || item.type !== event.type) return false;
      if (item.type === 'stage' && event.type === 'stage') return item.stage === event.stage && item.message === event.message;
      if (item.type === 'log' && event.type === 'log') return item.stage === event.stage && item.message === event.message;
      if (item.type === 'error' && event.type === 'error') return item.message === event.message;
      if (item.type === 'result' && event.type === 'result') return item.data.id === event.data.id && item.data.status === event.data.status;
      return true;
    });
  };

  /**
   * 使用运行中任务快照恢复进度展示。
   * @param snapshot 运行中任务快照
   */
  const hydrateProgressFromSnapshot = (snapshot: DeployProgressSnapshot) => {
    const stageEvent = [...snapshot.events].reverse().find((event) => event.type === 'stage');
    Object.assign(progressState, {
      percent: stageEvent?.type === 'stage' ? stageEvent.percent : snapshot.result ? 100 : 0,
      title: stageEvent?.type === 'stage' ? stageEvent.message : `正在${getDeployProgressActionLabel(snapshot.action)}`,
      detail:
        stageEvent?.type === 'stage'
          ? stageEvent.detail || ''
          : `${snapshot.operator || '未知操作人'}发起，当前阶段：${getDeployProgressStageLabel(snapshot)}`,
      logs: [...snapshot.events],
      running: snapshot.running,
      stopped: snapshot.result?.status === 'stopped',
    });
    if (snapshot.error) {
      progressState.title = getDeployProgressFailureTitle({
        action: snapshot.action,
        events: snapshot.events,
        fallbackStage: snapshot.currentStage,
      });
      progressState.detail = snapshot.action === 'deploy' ? DEPLOY_FAILURE_BRIEF : snapshot.error;
    }
  };

  /** 处理流式进度事件 */
  const handleProgressEvent = (event: DeployProgressEvent) => {
    if (!hasProgressEvent(event)) progressState.logs.push(event);
    if (event.type === 'stage') {
      progressState.percent = event.percent;
      progressState.title = event.message;
      progressState.detail = event.detail || '';
    }
    if (event.type === 'result') {
      if (event.data.status === 'stopped') {
        progressState.stopped = true;
        progressState.title = '已停止';
        progressState.detail = '发布任务已停止，未进入上传产物阶段。';
        return;
      }
      progressState.percent = 100;
      progressState.title = progressMode.value === 'undoRollback' ? '撤销回滚完成' : progressMode.value === 'rollback' ? '回滚完成' : '发布完成';
      progressState.detail =
        progressMode.value === 'undoRollback'
          ? `${activeRecord.value?.projectName || activePublishTarget.value?.projectName || '当前项目'} 撤销回滚成功`
          : progressMode.value === 'rollback'
          ? `${activeRecord.value?.projectName || activePublishTarget.value?.projectName || '当前项目'} 回滚成功`
          : `${activePublishTarget.value?.projectName || '当前项目'} 发布成功`;
    }
    if (event.type === 'error') {
      const isRestoreAction = progressMode.value === 'rollback' || progressMode.value === 'undoRollback';
      progressState.title = getDeployProgressFailureTitle({
        action: progressMode.value,
        events: progressState.logs,
        fallbackStage: event.stage || currentPublishStageKey.value,
      });
      progressState.detail = isRestoreAction ? event.message : DEPLOY_FAILURE_BRIEF;
    }
  };

  /**
   * 创建当前订阅专属的进度处理器，避免切换目标后旧流继续写入当前抽屉。
   * @param sessionId 进度订阅编号
   * @returns 进度事件处理函数
   */
  const createScopedProgressHandler = (sessionId: number) => {
    return (event: DeployProgressEvent) => {
      if (sessionId !== progressSessionId) return;
      handleProgressEvent(event);
    };
  };

  /**
   * 执行发布。
   * @param target 部署目标
   * @param options 发布启动选项
   */
  const runDeploy = async (target: DeployTarget, options: StartPublishOptions = {}) => {
    if (!ensureLoggedIn()) return;
    progressMode.value = 'deploy';
    const sessionId = ++progressSessionId;
    const abortController = new AbortController();
    deployAbortController = abortController;
    Object.assign(progressState, { percent: 0, title: '准备发布', detail: '', logs: [], running: true, stopped: false });
    try {
      const result = await deployTargetWithProgress(
        target.id,
        {
          branch: target.defaultBranch || 'dev',
          gitlabToken: authState.value.token || '',
          operator: userName.value || '',
          forceInstallDependencies: Boolean(options.forceInstallDependencies),
        },
        { signal: abortController.signal, onEvent: createScopedProgressHandler(sessionId) }
      );
      if (sessionId !== progressSessionId) return;
      if (result.status === 'stopped' || abortController.signal.aborted) {
        progressState.stopped = true;
        progressState.title = '已停止';
        progressState.detail = '发布任务已停止，未进入上传产物阶段。';
        await refreshActiveTab({ resetRecordsPage: true, force: true });
        return;
      }
      message.success('发布完成');
      await refreshActiveTab({ resetRecordsPage: true, force: true });
    } catch (error: any) {
      if (isAbortError(error) || abortController.signal.aborted) {
        if (sessionId === progressSessionId && publishStopping.value) {
          appendProgressStoppedLog();
          Object.assign(progressState, {
            title: '已停止',
            detail: '发布任务已停止，未进入上传产物阶段。',
            stopped: true,
          });
          message.warning('发布任务已停止');
          await new Promise((resolve) => window.setTimeout(resolve, 500));
          await refreshActiveTab({ resetRecordsPage: true, force: true });
        }
        return;
      }
      if (sessionId !== progressSessionId) return;
      const errorMessage = getErrorMessage(error);
      if (isDeployConflictError(error)) {
        message.warning(errorMessage);
        publishStarted.value = false;
        resetPublishProgress();
        publishConfirmOpen.value = true;
        return;
      }
      appendProgressErrorLog(errorMessage, currentPublishStageKey.value);
      progressState.title = getDeployProgressFailureTitle({
        action: progressMode.value,
        events: progressState.logs,
        fallbackStage: currentPublishStageKey.value,
      });
      progressState.detail = DEPLOY_FAILURE_BRIEF;
    } finally {
      if (sessionId === progressSessionId) {
        progressState.running = false;
        publishStopping.value = false;
        if (deployAbortController === abortController) deployAbortController = null;
        if (!publishConfirmOpen.value) resetPublishWorkbench();
      }
    }
  };

  /**
   * 订阅后端仍在运行的目标任务，用于查看其他页面或用户发起的发布、回滚进度。
   * @param target 部署目标
   * @param snapshot 运行中任务快照
   */
  const subscribeRunningTargetProgress = async (target: DeployTarget, snapshot: DeployProgressSnapshot) => {
    progressMode.value = snapshot.action;
    const sessionId = ++progressSessionId;
    const abortController = new AbortController();
    deployAbortController = abortController;
    activePublishTarget.value = target;
    if (snapshot.action !== 'deploy') activeRecord.value = snapshot.result;
    setTargetRuntimeSnapshot?.(snapshot);
    hydrateProgressFromSnapshot(snapshot);
    let shouldClearRuntime = false;
    if (snapshot.action === 'deploy') {
      publishStarted.value = true;
      publishConfirmOpen.value = true;
      rollbackProgressOpen.value = false;
    } else {
      publishStarted.value = false;
      publishConfirmOpen.value = false;
      rollbackProgressOpen.value = true;
    }

    try {
      const result = await subscribeTargetDeployProgress(target.id, {
        signal: abortController.signal,
        onEvent: createScopedProgressHandler(sessionId),
      });
      if (sessionId !== progressSessionId) return;
      if (result.status === 'stopped') {
        shouldClearRuntime = true;
        progressState.stopped = true;
        progressState.title = '已停止';
        progressState.detail = '发布任务已停止，未进入上传产物阶段。';
        await refreshActiveTab({ resetRecordsPage: true, force: true });
        return;
      }
      shouldClearRuntime = true;
      message.success(`${getDeployProgressActionLabel(snapshot.action)}完成`);
      await refreshActiveTab({ resetRecordsPage: true, force: true });
    } catch (error: any) {
      if (isAbortError(error) || abortController.signal.aborted || sessionId !== progressSessionId) return;
      if (isNotFoundError(error)) {
        clearTargetRuntimeSnapshot?.(target.id);
        message.info('当前任务已结束，请查看发布历史');
        await refreshActiveTab({ resetRecordsPage: true, force: true });
        resetPublishWorkbench();
        publishConfirmOpen.value = false;
        rollbackProgressOpen.value = false;
        return;
      }
      const errorMessage = getErrorMessage(error);
      shouldClearRuntime = true;
      appendProgressErrorLog(errorMessage, currentPublishStageKey.value || snapshot.currentStage);
      progressState.title = getDeployProgressFailureTitle({
        action: snapshot.action,
        events: progressState.logs,
        fallbackStage: currentPublishStageKey.value || snapshot.currentStage,
      });
      progressState.detail = snapshot.action === 'deploy' ? DEPLOY_FAILURE_BRIEF : errorMessage;
    } finally {
      if (sessionId === progressSessionId) {
        progressState.running = false;
        publishStopping.value = false;
        if (deployAbortController === abortController) deployAbortController = null;
        if (shouldClearRuntime) clearTargetRuntimeSnapshot?.(target.id);
        if (!publishConfirmOpen.value && !rollbackProgressOpen.value) resetPublishWorkbench();
      }
    }
  };

  /** 停止当前发布任务 */
  const stopCurrentPublish = async () => {
    const targetId = activePublishTarget.value?.id;
    if (!publishStoppable.value || !targetId) {
      message.warning('上传产物后不可停止当前发布任务');
      return;
    }
    publishStopping.value = true;
    progressState.title = '停止中';
    progressState.detail = '正在终止当前发布任务';
    appendProgressStoppedLog();
    try {
      await stopTargetDeploy(targetId);
    } catch (error: any) {
      publishStopping.value = false;
      message.error(getErrorMessage(error));
    }
  };

  /**
   * 执行回滚。
   * @param record 发布记录
   */
  const runRollback = async (record: DeployRecord) => {
    if (!ensureLoggedIn()) return;
    progressMode.value = 'rollback';
    activeRecord.value = record;
    rollbackProgressOpen.value = true;
    Object.assign(progressState, { percent: 0, title: '准备回滚', detail: '', logs: [], running: true, stopped: false });
    try {
      await rollbackRecordWithProgress(record.id, { operator: userName.value || '' }, { onEvent: handleProgressEvent });
      message.success('回滚完成');
      await refreshActiveTab({ resetRecordsPage: true, force: true });
    } catch (error: any) {
      const errorMessage = getErrorMessage(error);
      if (isDeployConflictError(error)) {
        message.warning(errorMessage);
        rollbackProgressOpen.value = false;
        resetPublishProgress();
        return;
      }
      appendProgressErrorLog(errorMessage);
      progressState.title = '回滚失败';
      progressState.detail = errorMessage;
      message.error(errorMessage);
    } finally {
      progressState.running = false;
    }
  };

  /**
   * 执行撤销回滚。
   * @param record 发布记录
   */
  const runUndoRollback = async (record: DeployRecord) => {
    if (!ensureLoggedIn()) return;
    progressMode.value = 'undoRollback';
    activeRecord.value = record;
    rollbackProgressOpen.value = true;
    Object.assign(progressState, { percent: 0, title: '准备撤销回滚', detail: '', logs: [], running: true, stopped: false });
    try {
      await undoRollbackRecordWithProgress(record.id, { operator: userName.value || '' }, { onEvent: handleProgressEvent });
      message.success('撤销回滚完成');
      await refreshActiveTab({ resetRecordsPage: true, force: true });
    } catch (error: any) {
      const errorMessage = getErrorMessage(error);
      if (isDeployConflictError(error)) {
        message.warning(errorMessage);
        rollbackProgressOpen.value = false;
        resetPublishProgress();
        return;
      }
      appendProgressErrorLog(errorMessage);
      progressState.title = '撤销回滚失败';
      progressState.detail = errorMessage;
      message.error(errorMessage);
    } finally {
      progressState.running = false;
    }
  };

  /**
   * 打开部署目标当前运行任务进度。
   * @param target 部署目标
   */
  const openTargetProgress = async (target: DeployTarget) => {
    if (!ensureLoggedIn()) return;
    try {
      const runningTask = await getTargetDeployProgress(target.id);
      if (!runningTask.running) {
        clearTargetRuntimeSnapshot?.(target.id);
        message.info('当前任务已结束，请查看发布历史');
        await refreshActiveTab({ resetRecordsPage: true, force: true });
        return;
      }
      detachPublishProgressStream();
      void subscribeRunningTargetProgress(target, runningTask);
    } catch (error: any) {
      clearTargetRuntimeSnapshot?.(target.id);
      if (isNotFoundError(error)) {
        message.info('当前任务已结束，请查看发布历史');
        await refreshActiveTab({ resetRecordsPage: true, force: true });
        return;
      }
      message.error(getErrorMessage(error));
    }
  };

  /**
   * 打开发布确认弹窗。
   * @param target 部署目标
   */
  const openPublishConfirm = async (target: DeployTarget) => {
    if (!ensureLoggedIn()) return;
    if (publishStarted.value && activePublishTarget.value?.id === target.id) {
      publishConfirmOpen.value = true;
      return;
    }
    try {
      const runningTask = await getTargetDeployProgress(target.id);
      detachPublishProgressStream();
      void subscribeRunningTargetProgress(target, runningTask);
      return;
    } catch (error: any) {
      if (!isNotFoundError(error)) {
        message.error(getErrorMessage(error));
        return;
      }
    }
    detachPublishProgressStream();
    activePublishTarget.value = target;
    publishStarted.value = false;
    resetPublishProgress();
    publishConfirmOpen.value = true;
  };

  /** 从确认弹窗开始发布 */
  const startPublishFromConfirm = async (options: StartPublishOptions = {}) => {
    if (!ensureLoggedIn()) return;
    const target = activePublishTarget.value;
    if (!target) {
      message.warning('发布目标不存在，请刷新后重试');
      return;
    }
    publishStarted.value = true;
    publishConfirmOpen.value = true;
    await runDeploy(target, options);
  };

  /**
   * 从确认弹窗重新发布
   * @param options 发布启动选项
   */
  const republishFromConfirm = async (options: StartPublishOptions = {}) => {
    if (!ensureLoggedIn()) return;
    const target = activePublishTarget.value;
    if (!target) {
      message.warning('发布目标不存在，请刷新后重试');
      return;
    }
    publishStarted.value = true;
    resetPublishProgress();
    await runDeploy(target, options);
  };

  /** 清空发布进度和临时态 */
  const clearProgressData = () => {
    detachPublishProgressStream();
    activePublishTarget.value = null;
    rollbackProgressOpen.value = false;
    publishConfirmOpen.value = false;
    publishStarted.value = false;
    publishStopping.value = false;
    resetPublishProgress();
  };

  watch(publishConfirmOpen, (open) => {
    if (!open && !progressState.running) {
      resetPublishWorkbench();
    }
  });

  return {
    rollbackProgressOpen,
    publishConfirmOpen,
    publishStarted,
    publishStopping,
    publishStoppable,
    rollbackProgressTitle,
    activePublishTarget,
    progressState,
    detachPublishProgressStream,
    openTargetProgress,
    openPublishConfirm,
    startPublishFromConfirm,
    republishFromConfirm,
    stopCurrentPublish,
    runRollback,
    runUndoRollback,
    clearProgressData,
  };
}
