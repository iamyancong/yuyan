/**
 * 发布进度日志缓冲（#61）。
 * @description 去重改为按 seq / 复合键的 Set（O(1)），日志数组用 markRaw 保存并整体替换引用，
 * 普通日志行合批写入，阶段 / 错误 / 结果立即写入。避免查看他人长日志任务时 O(N²) 的响应式去重卡死主线程。
 */
import { markRaw } from 'vue';
import type { DeployProgressEvent } from '@/api/deploy';

/** 普通日志合批间隔（毫秒），与服务端 100ms 合批写出相匹配 */
export const PROGRESS_LOG_FLUSH_MS = 60;

/**
 * 计算进度事件去重键：有 seq 用 seq，否则用类型 + 时间 + 阶段 + 文案。
 * @param event 进度事件
 * @returns 去重键
 */
export function getProgressEventKey(event: DeployProgressEvent): string {
  if (event.omittedMarker && !event.seq && event.type === 'log') return `omitted|${event.message}`;
  if (typeof event.seq === 'number' && event.seq > 0) return `s:${event.seq}`;
  if (event.type === 'stage') return `stage|${event.timestamp}|${event.stage}|${event.message}`;
  if (event.type === 'log') return `log|${event.timestamp}|${event.stage || ''}|${event.message}`;
  if (event.type === 'error') return `error|${event.timestamp}|${event.message}`;
  return `result|${event.timestamp}`;
}

/** 缓冲配置 */
export interface ProgressLogBufferOptions {
  /** 写回日志数组（整体替换引用以触发视图更新） */
  write: (logs: DeployProgressEvent[]) => void;
  /** 读取外部当前日志数组；外部整体替换（如重置为空）后，缓冲会以外部为准重建去重键 */
  read?: () => DeployProgressEvent[];
  /** 合批调度器，默认 setTimeout */
  schedule?: (callback: () => void, delay: number) => unknown;
  /** 取消调度 */
  cancel?: (handle: unknown) => void;
  /** 合批间隔 */
  flushMs?: number;
}

/** 日志缓冲实例 */
export interface ProgressLogBuffer {
  /** 用一组事件替换当前日志（会去重） */
  replace: (events: DeployProgressEvent[]) => void;
  /** 追加事件；重复返回 false。immediate 为 true 时立即写入 */
  append: (event: DeployProgressEvent, immediate?: boolean) => boolean;
  /** 立即写入所有待写事件 */
  flush: () => void;
  /** 当前（含待写）日志 */
  snapshot: () => DeployProgressEvent[];
  /** 是否已有相同事件 */
  has: (event: DeployProgressEvent) => boolean;
  /** 外部替换过日志数组时以外部为准重建（丢弃待写事件） */
  sync: () => void;
}

/**
 * 创建进度日志缓冲。
 * @param options 配置
 * @returns 缓冲实例
 */
export function createProgressLogBuffer(options: ProgressLogBufferOptions): ProgressLogBuffer {
  const schedule = options.schedule ?? ((callback: () => void, delay: number) => setTimeout(callback, delay));
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const flushMs = options.flushMs ?? PROGRESS_LOG_FLUSH_MS;
  let keys = new Set<string>();
  let logs: DeployProgressEvent[] = markRaw([]);
  let pending: DeployProgressEvent[] = [];
  let timer: unknown = null;

  /** 外部是否整体替换过日志数组 */
  const isExternallyReplaced = () => {
    if (!options.read) return false;
    return options.read() !== logs;
  };

  const flush = () => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    if (isExternallyReplaced()) {
      // 外部已重置（新任务 / 关闭抽屉），待写事件属于旧会话，丢弃
      replace(options.read ? [...options.read()] : []);
      return;
    }
    if (!pending.length) return;
    logs = markRaw(logs.concat(pending));
    pending = [];
    options.write(logs);
  };

  const replace = (events: DeployProgressEvent[]) => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    pending = [];
    keys = new Set<string>();
    const next: DeployProgressEvent[] = [];
    for (const event of events) {
      const key = getProgressEventKey(event);
      if (keys.has(key)) continue;
      keys.add(key);
      next.push(event);
    }
    logs = markRaw(next);
    options.write(logs);
  };

  const sync = () => {
    if (isExternallyReplaced()) replace(options.read ? [...options.read()] : []);
  };

  const append = (event: DeployProgressEvent, immediate = event.type !== 'log') => {
    sync();
    const key = getProgressEventKey(event);
    if (keys.has(key)) return false;
    keys.add(key);
    pending.push(event);
    if (immediate) {
      flush();
    } else if (timer === null) {
      timer = schedule(flush, flushMs);
    }
    return true;
  };

  return {
    replace,
    append,
    flush,
    snapshot: () => (pending.length ? logs.concat(pending) : logs),
    has: (event) => {
      sync();
      return keys.has(getProgressEventKey(event));
    },
    sync,
  };
}

/**
 * 快照只带最近若干条事件时，在开头补一条说明（#61）。
 * @param events 快照事件
 * @param omittedEventCount 未返回的更早事件数
 * @param startedAt 任务开始时间
 * @returns 带说明的事件列表
 */
export function withOmittedEventsNotice(
  events: DeployProgressEvent[],
  omittedEventCount = 0,
  startedAt = ''
): DeployProgressEvent[] {
  if (!omittedEventCount || omittedEventCount <= 0) return events;
  const notice: DeployProgressEvent = {
    type: 'log',
    level: 'info',
    stage: '',
    message: `……更早的 ${omittedEventCount} 条日志未加载，这里只显示最近的部分；完整日志可在发布记录中查看……`,
    timestamp: startedAt || events[0]?.timestamp || new Date(0).toISOString(),
    omittedMarker: true,
  };
  return [notice, ...events];
}
