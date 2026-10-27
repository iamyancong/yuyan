/**
 * 独立服务器部署任务并发与 FIFO 排队调度器。
 * @description 控制全局同时执行的任务槽位上限（默认 7），超出并发时进入有界 FIFO 队列（默认 20）；
 * 支持排队名次实时推进通知、排队期间取消（立即退队不创建脏记录）以及排队等待超时保护。
 */

/** 默认同时运行的部署/回滚/服务操作任务上限 */
export const DEFAULT_MAX_RUNNING_DEPLOY_TASKS = Math.max(
  1,
  Number(process.env.YUYAN_MAX_RUNNING_DEPLOY_TASKS || 7)
);

/** 默认最大排队等待任务上限 */
export const DEFAULT_MAX_QUEUED_DEPLOY_TASKS = Math.max(
  1,
  Number(process.env.YUYAN_MAX_QUEUED_DEPLOY_TASKS || 20)
);

/** 单任务排队最长等待毫秒数（默认 15 分钟） */
export const DEFAULT_QUEUE_WAIT_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.YUYAN_DEPLOY_QUEUE_TIMEOUT_MS || 15 * 60_000)
);

/** 不涉及 Git 克隆与本地编译的轻量级远程操作集合（绕过全局构建/发布排队队列，仅受单目标互斥锁保护） */
export const LIGHTWEIGHT_DEPLOY_ACTIONS = new Set([
  'rollback',
  'undoRollback',
  'start',
  'stop',
  'restart',
]);

/**
 * 判断任务动作是否属于轻量级快速通道操作（回滚、撤销回滚、服务启停重启）。
 * @param {string} action 任务动作
 * @returns {boolean}
 */
export function isLightweightDeployAction(action) {
  return LIGHTWEIGHT_DEPLOY_ACTIONS.has(String(action || '').trim());
}

/**
 * 根据排队位次与并发上限估算排队等待分钟数。
 * @param {number} queuePosition 当前排队名次（从 1 开始）
 * @param {number} maxRunning 最大并发运行数
 * @param {number} [avgWaveMinutes=4] 每批平均耗时（分钟）
 * @returns {number} 预计等待分钟数
 */
export function estimateQueueWaitMinutes(queuePosition, maxRunning, avgWaveMinutes = 4) {
  const pos = Math.max(1, Number(queuePosition || 1));
  const cap = Math.max(1, Number(maxRunning || DEFAULT_MAX_RUNNING_DEPLOY_TASKS));
  return Math.max(1, Math.ceil(pos / cap) * avgWaveMinutes);
}

/** 队列已满冲突错误 */
export class DeployQueueFullError extends Error {
  /**
   * @param {number} maxRunning 最大并发运行数
   * @param {number} maxQueued 最大排队数
   */
  constructor(maxRunning, maxQueued) {
    super(`当前已有 ${maxRunning} 个发布任务正在执行、${maxQueued} 个任务正在排队，队列已满，请稍后重试`);
    this.name = 'DeployQueueFullError';
    this.code = 'DEPLOY_QUEUE_FULL';
    this.status = 429;
    this.statusCode = 429;
  }
}

/** 同一部署目标已有活跃任务（运行中或排队中）时的互斥冲突错误 */
export class DeployTargetBusyError extends Error {
  /**
   * @param {number} targetId 部署目标 ID
   * @param {Object} [existingTask] 当前占用的任务对象
   */
  constructor(targetId, existingTask = null) {
    const operatorText = existingTask?.operator ? `「${existingTask.operator}」` : '其他成员';
    const isQueued = Boolean(existingTask?.queued || existingTask?.currentStage === 'queued');
    const stateVerb = isQueued ? '排队等待' : '执行';
    const suffix = isQueued ? '，可先停止排队中的发布后再操作' : '，请稍后重试';
    super(`该部署目标正由 ${operatorText} ${stateVerb}任务${suffix}`);
    this.name = 'DeployTargetBusyError';
    this.code = 'DEPLOY_TARGET_BUSY';
    this.status = 409;
    this.statusCode = 409;
    this.targetId = targetId;
    this.existingTask = existingTask;
  }
}

/**
 * 创建部署任务并发与 FIFO 队列调度器实例。
 * @param {Object} [options] 调度器参数
 * @param {number} [options.maxRunning] 最大并发运行数
 * @param {number} [options.maxQueued] 最大等待队列长度
 * @param {number} [options.queueTimeoutMs] 排队最大等待时长（毫秒）
 * @returns {Object} 调度器实例
 */
export function createDeployTaskScheduler(options = {}) {
  const maxRunning = Math.max(1, Number(options.maxRunning || DEFAULT_MAX_RUNNING_DEPLOY_TASKS));
  const maxQueued = Math.max(1, Number(options.maxQueued || DEFAULT_MAX_QUEUED_DEPLOY_TASKS));
  const hasCustomTimeout = options.queueTimeoutMs !== undefined && options.queueTimeoutMs !== null;
  const queueTimeoutMs = Math.max(20, Number(options.queueTimeoutMs || DEFAULT_QUEUE_WAIT_TIMEOUT_MS));

  /** @type {Map<number, Object>} 包含正在运行与正在排队的全部活跃任务（按 targetId 唯一） */
  const tasksByTargetId = new Map();

  /** @type {Set<number>} 当前正占用执行槽位的 targetId 集合 */
  const runningTargetIds = new Set();

  /** @type {Array<{task: Object, runner: () => Promise<Object>, hooks: Object, resolve: Function, reject: Function, cleanupQueueListeners: () => void}>} */
  const pendingQueue = [];

  /**
   * 获取当前运行与队列统计信息。
   * @returns {{runningCount: number, queuedCount: number, activeCount: number, maxConcurrent: number, maxQueueSize: number}}
   */
  function getStats() {
    return {
      runningCount: runningTargetIds.size,
      queuedCount: pendingQueue.length,
      activeCount: tasksByTargetId.size,
      maxConcurrent: maxRunning,
      maxQueueSize: maxQueued,
    };
  }

  /**
   * 判断当前是否还能接纳新任务（运行槽位未满或等待队列未满）。
   * @returns {boolean}
   */
  function canAcceptTask() {
    return runningTargetIds.size < maxRunning || pendingQueue.length < maxQueued;
  }

  /**
   * 重新计算等待队列中所有任务的排队名次，并在名次变化时触发回调。
   */
  function refreshQueuePositions() {
    const stats = getStats();
    pendingQueue.forEach((entry, index) => {
      const nextPosition = index + 1;
      const changed = entry.task.queuePosition !== nextPosition;
      entry.task.queuePosition = nextPosition;
      if (changed) {
        try {
          entry.hooks?.onPositionChanged?.(entry.task, nextPosition, stats);
        } catch {}
      }
    });
  }

  /**
   * 尝试从 FIFO 队列头部取出任务补充到空闲运行槽位。
   */
  function drainQueue() {
    while (runningTargetIds.size < maxRunning && pendingQueue.length > 0) {
      const nextEntry = pendingQueue.shift();
      if (!nextEntry) break;
      nextEntry.cleanupQueueListeners();
      const { task, runner, hooks, resolve, reject } = nextEntry;
      if (task.completed || task.controller?.signal?.aborted) {
        if (tasksByTargetId.get(task.targetId) === task) {
          tasksByTargetId.delete(task.targetId);
        }
        continue;
      }
      task.queued = false;
      task.queuePosition = 0;
      task.currentStage = 'validate';
      runningTargetIds.add(task.targetId);
      refreshQueuePositions();
      try {
        hooks?.onStartExecution?.(task, getStats());
      } catch {}
      executeTask(task, runner, hooks).then(resolve, reject);
    }
    refreshQueuePositions();
  }

  /**
   * 实际执行已获得运行槽位的任务。
   * @param {Object} task 任务对象
   * @param {() => Promise<Object>} runner 执行函数
   * @param {Object} hooks 生命周期回调
   * @param {{bypassQueue?: boolean}} [execOptions] 执行选项
   * @returns {Promise<Object>}
   */
  async function executeTask(task, runner, hooks, execOptions = {}) {
    const bypassQueue = Boolean(execOptions.bypassQueue);
    try {
      const result = await runner();
      if (hooks?.onSuccess) {
        await hooks.onSuccess(task, result, getStats());
      }
      return result;
    } catch (error) {
      if (hooks?.onError) {
        await hooks.onError(task, error, getStats());
      }
      throw error;
    } finally {
      if (!bypassQueue) {
        runningTargetIds.delete(task.targetId);
      }
      if (tasksByTargetId.get(task.targetId) === task) {
        tasksByTargetId.delete(task.targetId);
      }
      try {
        hooks?.onComplete?.(task, getStats());
      } catch {}
      if (!bypassQueue) {
        drainQueue();
      }
    }
  }

  /**
   * 提交任务：轻量操作走快速通道直通执行；重型发布/构建任务若有空闲槽位则立即执行，否则进入 FIFO 等待队列。
   * @param {Object} task 任务上下文
   * @param {() => Promise<Object>} runner 实际执行函数
   * @param {Object} [hooks] 生命周期钩子
   * @returns {Promise<Object>} 任务终态 Promise
   */
  function scheduleTask(task, runner, hooks = {}) {
    const existingTask = tasksByTargetId.get(task.targetId);
    if (existingTask && existingTask !== task && !existingTask.completed) {
      throw new DeployTargetBusyError(task.targetId, existingTask);
    }

    const bypassQueue = Boolean(hooks?.bypassQueue ?? isLightweightDeployAction(task?.action));

    if (bypassQueue) {
      tasksByTargetId.set(task.targetId, task);
      task.queued = false;
      task.queuePosition = 0;
      try {
        hooks?.onStartExecution?.(task, getStats());
      } catch {}
      const promise = executeTask(task, runner, hooks, { bypassQueue: true });
      task.promise = promise;
      promise.catch(() => {});
      return promise;
    }

    if (!canAcceptTask()) {
      throw new DeployQueueFullError(maxRunning, maxQueued);
    }

    tasksByTargetId.set(task.targetId, task);

    if (runningTargetIds.size < maxRunning) {
      task.queued = false;
      task.queuePosition = 0;
      runningTargetIds.add(task.targetId);
      try {
        hooks?.onStartExecution?.(task, getStats());
      } catch {}
      const promise = executeTask(task, runner, hooks);
      task.promise = promise;
      promise.catch(() => {});
      return promise;
    }

    task.queued = true;
    task.currentStage = 'queued';
    task.queuePosition = pendingQueue.length + 1;

    const effectiveQueueTimeoutMs = hasCustomTimeout
      ? queueTimeoutMs
      : Math.max(queueTimeoutMs, Math.ceil(task.queuePosition / maxRunning) * 10 * 60_000);

    const promise = new Promise((resolve, reject) => {
      let timeoutId = null;

      /** 清理排队期间的取消与超时监听 */
      const cleanupQueueListeners = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        task.controller?.signal?.removeEventListener?.('abort', handleAbortWhileQueued);
      };

      const entry = {
        task,
        runner,
        hooks,
        resolve,
        reject,
        cleanupQueueListeners,
      };

      /** 排队期间收到停止信号或等待超时 */
      function handleAbortWhileQueued() {
        cleanupQueueListeners();
        const index = pendingQueue.indexOf(entry);
        if (index >= 0) pendingQueue.splice(index, 1);
        task.queued = false;
        task.queuePosition = 0;
        if (tasksByTargetId.get(task.targetId) === task) {
          tasksByTargetId.delete(task.targetId);
        }
        refreshQueuePositions();

        Promise.resolve()
          .then(async () => {
            if (hooks?.onAbortedWhileQueued) {
              return await hooks.onAbortedWhileQueued(task, task.controller?.signal?.reason, getStats());
            }
            throw task.controller?.signal?.reason || new Error('排队任务已取消');
          })
          .then(
            (resVal) => {
              try {
                hooks?.onComplete?.(task, getStats());
              } catch {}
              resolve(resVal);
            },
            (errVal) => {
              try {
                hooks?.onComplete?.(task, getStats());
              } catch {}
              reject(errVal);
            }
          );
      }

      timeoutId = setTimeout(() => {
        timeoutId = null;
        if (!task.controller?.signal?.aborted) {
          const timeoutError = new Error('排队超时，未产生任何变更');
          timeoutError.code = 'DEPLOY_QUEUE_TIMEOUT';
          task.controller?.abort?.(timeoutError);
        }
      }, effectiveQueueTimeoutMs);

      task.controller?.signal?.addEventListener?.('abort', handleAbortWhileQueued, { once: true });
      pendingQueue.push(entry);

      try {
        hooks?.onQueued?.(task, task.queuePosition, getStats());
      } catch {}
    });

    task.promise = promise;
    promise.catch(() => {});
    return promise;
  }

  return {
    maxRunning,
    maxQueued,
    tasksByTargetId,
    getTask: (targetId) => tasksByTargetId.get(Number(targetId)),
    getStats,
    canAcceptTask,
    scheduleTask,
  };
}

/** 进程级默认部署任务调度器单例 */
export const deployTaskScheduler = createDeployTaskScheduler();
