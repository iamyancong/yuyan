/**
 * 发布任务进度事件的内存管理（#61）。
 * @description 每条事件带递增 seq；内存中只保留「前 N 条 + 最近 M 条日志」，中间的日志行折叠成一条省略标记，
 * 阶段 / 错误 / 结果事件始终保留。完整日志由发布记录（deploy_records.logs / 日志文件）保存，不受影响。
 */

/** 内存中保留的开头事件数 */
export const DEFAULT_TASK_EVENT_HEAD = Math.max(10, Number(process.env.YUYAN_TASK_EVENT_HEAD || 500));
/** 内存中保留的最近事件数 */
export const DEFAULT_TASK_EVENT_TAIL = Math.max(100, Number(process.env.YUYAN_TASK_EVENT_TAIL || 5000));
/** 超出上限后每次批量折叠的条数，避免每条事件都搬移数组 */
const TRIM_BATCH = 500;
/** 非流式进度快照默认返回的最近事件数 */
export const DEFAULT_SNAPSHOT_EVENT_TAIL = Math.max(20, Number(process.env.YUYAN_PROGRESS_SNAPSHOT_TAIL || 200));

/**
 * 初始化任务事件字段。
 * @param {Object} task 任务上下文
 */
export function ensureTaskEventState(task) {
  if (!Array.isArray(task.events)) task.events = [];
  if (!Number.isFinite(task.eventSeq)) task.eventSeq = 0;
  if (!Number.isFinite(task.omittedEventCount)) task.omittedEventCount = 0;
}

/**
 * 追加事件：分配 seq、记录最新阶段与错误标记，并按上限折叠中间日志。
 * @param {Object} task 任务上下文
 * @param {Object} event 事件（会被写入 seq）
 * @param {{head?: number, tail?: number}} [limits] 上限
 * @returns {Object} 写入后的事件
 */
export function appendTaskEvent(task, event, limits = {}) {
  ensureTaskEventState(task);
  task.eventSeq += 1;
  event.seq = task.eventSeq;
  if (event.type === 'stage') {
    task.latestStageEvent = event;
    if (event.stage === 'queued') task.wasQueued = true;
  }
  if (event.type === 'error') task.hasErrorEvent = true;
  task.events.push(event);
  trimTaskEvents(task, limits);
  return event;
}

/**
 * 超过上限时把开头之后、最近窗口之前的日志行折叠为一条省略标记。
 * @param {Object} task 任务上下文
 * @param {{head?: number, tail?: number}} [limits] 上限
 */
export function trimTaskEvents(task, limits = {}) {
  const head = Math.max(1, Number(limits.head || DEFAULT_TASK_EVENT_HEAD));
  const tail = Math.max(1, Number(limits.tail || DEFAULT_TASK_EVENT_TAIL));
  const events = task.events;
  const hasMarker = Boolean(events[head]?.omittedMarker);
  const middleStart = head + (hasMarker ? 1 : 0);
  const maxLength = middleStart + tail + TRIM_BATCH;
  if (events.length <= maxLength) return;

  const middleEnd = events.length - tail;
  const middle = events.slice(middleStart, middleEnd);
  const kept = [];
  let removed = 0;
  let lastRemoved = null;
  for (const item of middle) {
    if (item.type === 'log') {
      removed += 1;
      lastRemoved = item;
    } else {
      kept.push(item);
    }
  }
  if (!removed) return;
  task.omittedEventCount = Number(task.omittedEventCount || 0) + removed;
  const marker = {
    type: 'log',
    level: 'warn',
    stage: lastRemoved?.stage || '',
    message: `……中间已省略 ${task.omittedEventCount} 行日志，完整日志请在发布记录中查看……`,
    timestamp: lastRemoved?.timestamp || new Date().toISOString(),
    taskId: lastRemoved?.taskId,
    targetId: lastRemoved?.targetId,
    seq: lastRemoved?.seq || 0,
    omittedMarker: true,
    omittedCount: task.omittedEventCount,
  };
  events.splice(head, middleEnd - head, marker, ...kept);
}

/**
 * 取最近 N 条事件；若最新阶段事件不在其中则补到最前面，保证快照能还原当前阶段。
 * @param {Object} task 任务上下文
 * @param {number} [limit] 条数
 * @returns {{events: Object[], omittedEventCount: number, lastSeq: number}}
 */
export function getTaskEventTail(task, limit = DEFAULT_SNAPSHOT_EVENT_TAIL) {
  ensureTaskEventState(task);
  const size = Math.max(0, Number(limit));
  const tailEvents = size > 0 ? task.events.slice(-size) : [];
  const latestStage = task.latestStageEvent;
  if (latestStage && !tailEvents.includes(latestStage)) tailEvents.unshift(latestStage);
  const firstTailSeq = tailEvents.find((item) => item !== latestStage)?.seq || task.eventSeq + 1;
  const omittedEventCount = Math.max(0, firstTailSeq - 1 - (latestStage && latestStage.seq < firstTailSeq ? 1 : 0));
  return { events: tailEvents, omittedEventCount, lastSeq: task.eventSeq };
}

/**
 * 取 seq 大于 afterSeq 的事件（流式订阅续传用）。
 * @param {Object} task 任务上下文
 * @param {number} [afterSeq=0] 已拿到的最大 seq
 * @returns {Object[]}
 */
export function getTaskEventsAfter(task, afterSeq = 0) {
  ensureTaskEventState(task);
  const after = Math.max(0, Number(afterSeq) || 0);
  if (!after) return task.events;
  return task.events.filter((item) => Number(item.seq || 0) > after && !item.omittedMarker);
}
