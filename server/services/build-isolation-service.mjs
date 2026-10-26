/**
 * 本地构建子进程资源隔离与并发槽位调度服务。
 * @description 为独立服务器部署的本地重 CPU 阶段（依赖安装、前端 Vite/Webpack 打包、后端 Maven 编译与 OpenAPI 生成）提供：
 * 1. 构建并发槽位信号量（默认 3~5，与总任务并发 7 解耦，使 I/O 阶段与 CPU 构建阶段错峰并行）；
 * 2. 子进程 OS 低调度优先级（PRIORITY_BELOW_NORMAL），保障主服务 Express 事件循环优先获得 CPU 时间片；
 * 3. 构建子进程环境变量护栏（NODE_OPTIONS 堆上限、UV_THREADPOOL_SIZE 线程收敛、CI 非交互标志）。
 */

import os from 'node:os';

const cpuCount = Array.isArray(os.cpus()) && os.cpus().length > 0 ? os.cpus().length : 8;
const adaptiveDefaultSlots = Math.max(3, Math.min(5, Math.floor(cpuCount / 2)));

/** 默认本地同时执行的重型构建/安装任务槽位上限（默认处于 3~5 区间） */
export const DEFAULT_MAX_CONCURRENT_BUILDS = Math.max(
  1,
  Number(process.env.YUYAN_MAX_CONCURRENT_BUILDS || adaptiveDefaultSlots)
);

const totalSystemMemoryMb = Math.floor((Number(os.totalmem?.() || 0) || 8 * 1024 * 1024 * 1024) / (1024 * 1024));
const adaptiveDefaultMaxOldSpaceMb = Math.max(
  4096,
  Math.min(8192, Math.floor(totalSystemMemoryMb * 0.75))
);

/** 默认单构建 Node 子进程最大老生代堆内存（MB，按服务器物理内存自适应 4096~8192MB，确保大型前端工程默认顺利打包不发生 Node OOM） */
export const DEFAULT_BUILD_MAX_OLD_SPACE_MB = Math.max(
  512,
  Number(process.env.YUYAN_BUILD_MAX_OLD_SPACE_MB || adaptiveDefaultMaxOldSpaceMb)
);

/** OOM 自动重试时的扩容老生代堆内存上限（MB，按服务器物理内存自适应 8192~12288MB） */
export const FALLBACK_RETRY_MAX_OLD_SPACE_MB = Math.max(
  DEFAULT_BUILD_MAX_OLD_SPACE_MB,
  Math.min(12288, Math.max(8192, Math.floor(totalSystemMemoryMb * 0.85)))
);

/**
 * 从命令文本中提取内联环境变量赋值（支持 export / cross-env 前缀、单双引号及 && 多段命令），并返回剥离后的纯命令。
 * 彻底解决：
 * 1. `NODE_OPTIONS="..." cd packages && pnpm build` 在 Shell 中仅对首条 cd 子命令生效的问题；
 * 2. Windows cmd.exe 不支持 `KEY=VALUE command` 内联环境变量语法的问题；
 * 3. 构建命令内联 `--max-old-space-size` 与默认 `NODE_OPTIONS` 护栏冲突的问题。
 * @param {string} command 原始命令文本
 * @returns {{ envVars: Record<string, string>, cleanedCommand: string }} 提取出的环境变量与剥离后的命令
 */
export function extractInlineCommandEnv(command) {
  const raw = String(command || '').trim();
  /** @type {Record<string, string>} */
  const envVars = {};
  if (!raw || /[;|<>`\n\r$()]/.test(raw)) {
    return { envVars, cleanedCommand: raw };
  }

  const prefixTokenRegex = /^(?:export|cross-env)\s+/i;
  const assignmentRegex = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s;&|]*))(?:\s+|$)/;

  const segments = raw.split(/\s*&&\s*/);
  const cleanedSegments = [];

  for (const segment of segments) {
    let rem = segment.trim();
    while (rem) {
      const prefixMatch = rem.match(prefixTokenRegex);
      const afterPrefix = prefixMatch ? rem.slice(prefixMatch[0].length) : rem;
      const match = afterPrefix.match(assignmentRegex);
      if (!match) break;

      const key = match[1];
      const value = match[2] ?? match[3] ?? match[4] ?? '';
      envVars[key] = value;
      rem = afterPrefix.slice(match[0].length).trim();
    }
    if (rem) {
      cleanedSegments.push(rem);
    }
  }

  const cleanedCommand = cleanedSegments.length > 0 ? cleanedSegments.join(' && ') : raw;
  return { envVars, cleanedCommand };
}

/** 默认单构建子进程 libuv 线程池大小（保持 Node.js 标准默认值 4，不人为压低文件 I/O 与打包并发） */
export const DEFAULT_BUILD_UV_THREADPOOL_SIZE = Math.max(
  1,
  Number(process.env.YUYAN_BUILD_UV_THREADPOOL_SIZE || 4)
);

/**
 * 将子进程调度优先级下调为低于标准（PRIORITY_BELOW_NORMAL），防止打包抢占主服务事件循环。
 * @param {number|undefined} pid 子进程 PID
 * @returns {boolean} 是否成功设置低优先级
 */
export function applyLowProcessPriority(pid) {
  const numericPid = Number(pid || 0);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    const lowPriority = os.constants?.priority?.PRIORITY_BELOW_NORMAL ?? 10;
    os.setPriority(numericPid, lowPriority);
    return true;
  } catch {
    return false;
  }
}

/**
 * 构建带资源护栏的子进程环境变量对象。
 * @param {Record<string, string|undefined>} [baseEnv={}] 基础环境变量
 * @param {Object} [options={}] 隔离选项
 * @param {boolean} [options.injectNodeHeapLimit=true] 是否在未显式指定时注入 --max-old-space-size
 * @param {number} [options.maxOldSpaceMb] 自定义老生代内存上限（MB）
 * @param {number} [options.uvThreadpoolSize] 自定义 UV_THREADPOOL_SIZE
 * @param {string} [options.command] 待执行的命令文本（用于自动提取内联 NODE_OPTIONS 等环境变量）
 * @returns {Record<string, string>} 合并后的环境变量
 */
export function buildIsolatedCommandEnv(baseEnv = {}, options = {}) {
  const inlineEnv = options.command ? extractInlineCommandEnv(options.command).envVars : {};
  const baseNodeOpts = String(baseEnv.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? '').trim();
  const inlineNodeOpts = String(inlineEnv.NODE_OPTIONS || '').trim();

  const merged = {
    ...process.env,
    ...baseEnv,
    ...inlineEnv,
  };

  if (baseNodeOpts && inlineNodeOpts) {
    // 若内联命令指定了 --max-old-space-size，移除 baseNodeOpts 中的同名参数后合并
    const cleanedBase = /--max-old-space-size\b/.test(inlineNodeOpts)
      ? baseNodeOpts.replace(/--max-old-space-size(?:=|\s+)\d+/g, '').trim()
      : baseNodeOpts;
    merged.NODE_OPTIONS = cleanedBase ? `${cleanedBase} ${inlineNodeOpts}` : inlineNodeOpts;
  }

  if (!merged.CI) {
    merged.CI = 'true';
  }
  if (!merged.UV_THREADPOOL_SIZE) {
    merged.UV_THREADPOOL_SIZE = String(options.uvThreadpoolSize || DEFAULT_BUILD_UV_THREADPOOL_SIZE);
  }

  if (options.injectNodeHeapLimit !== false) {
    const existingNodeOptions = String(merged.NODE_OPTIONS || '').trim();
    if (!/--max-old-space-size\b/.test(existingNodeOptions)) {
      const cmdHeapMatch = String(options.command || '').match(/--max-old-space-size(?:=|\s+)(\d+)/);
      const heapMb = Math.max(
        512,
        Number(options.maxOldSpaceMb || (cmdHeapMatch ? cmdHeapMatch[1] : 0) || DEFAULT_BUILD_MAX_OLD_SPACE_MB)
      );
      const heapFlag = `--max-old-space-size=${heapMb}`;
      merged.NODE_OPTIONS = existingNodeOptions ? `${existingNodeOptions} ${heapFlag}` : heapFlag;
    }
  }

  return merged;
}

/**
 * 创建本地构建并发槽位限制器。
 * @param {Object} [options={}] 配置参数
 * @param {number} [options.maxConcurrent] 最大并发构建槽位数（默认 3~5）
 * @returns {Object} 构建槽位限制器实例
 */
export function createBuildSlotLimiter(options = {}) {
  const maxConcurrent = Math.max(1, Number(options.maxConcurrent || DEFAULT_MAX_CONCURRENT_BUILDS));
  let activeCount = 0;
  /** @type {Array<{grant: () => void, reject: (err: Error) => void, cleanup: () => void}>} */
  const waitQueue = [];

  /**
   * 获取当前构建槽位运行与等待统计。
   * @returns {{activeBuilds: number, waitingBuilds: number, maxConcurrentBuilds: number}}
   */
  function getStats() {
    return {
      activeBuilds: activeCount,
      waitingBuilds: waitQueue.length,
      maxConcurrentBuilds: maxConcurrent,
    };
  }

  /**
   * 释放一个构建槽位并唤醒队列中的下一个等待任务。
   */
  function releaseSlot() {
    activeCount = Math.max(0, activeCount - 1);
    while (activeCount < maxConcurrent && waitQueue.length > 0) {
      const next = waitQueue.shift();
      if (!next) break;
      next.cleanup();
      activeCount += 1;
      next.grant();
    }
  }

  /**
   * 申请一个构建槽位，在槽位内执行异步构建函数，并在完成后自动归还槽位。
   * @template T
   * @param {() => Promise<T>} runner 构建执行函数
   * @param {Object} [slotOptions={}] 槽位申请选项
   * @param {AbortSignal} [slotOptions.signal] 取消信号
   * @param {(info: {waitingPosition: number, activeBuilds: number, maxConcurrentBuilds: number}) => void} [slotOptions.onWait] 进入等待队列时的回调
   * @returns {Promise<T>}
   */
  async function withBuildSlot(runner, slotOptions = {}) {
    const { signal, onWait } = slotOptions;
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || '构建任务已取消'));
    }

    if (activeCount < maxConcurrent) {
      activeCount += 1;
    } else {
      await new Promise((resolve, reject) => {
        const waitingPosition = waitQueue.length + 1;
        try {
          onWait?.({
            waitingPosition,
            activeBuilds: activeCount,
            maxConcurrentBuilds: maxConcurrent,
          });
        } catch {}

        const cleanup = () => {
          signal?.removeEventListener?.('abort', handleAbort);
        };

        const entry = {
          grant: resolve,
          reject,
          cleanup,
        };

        function handleAbort() {
          cleanup();
          const idx = waitQueue.indexOf(entry);
          if (idx >= 0) waitQueue.splice(idx, 1);
          const abortReason = signal?.reason;
          reject(abortReason instanceof Error ? abortReason : new Error(String(abortReason || '构建任务已取消')));
        }

        signal?.addEventListener?.('abort', handleAbort, { once: true });
        waitQueue.push(entry);
      });
    }

    try {
      return await runner();
    } finally {
      releaseSlot();
    }
  }

  return {
    maxConcurrent,
    getStats,
    withBuildSlot,
  };
}

/** 进程级默认构建槽位限制器单例 */
export const buildSlotLimiter = createBuildSlotLimiter();

/**
 * 使用全局构建槽位执行本地构建逻辑。
 * @template T
 * @param {() => Promise<T>} runner 构建执行器
 * @param {Object} [options={}] 槽位选项
 * @returns {Promise<T>}
 */
export function withBuildSlot(runner, options = {}) {
  return buildSlotLimiter.withBuildSlot(runner, options);
}

/**
 * 获取全局构建槽位实时统计。
 * @returns {{activeBuilds: number, waitingBuilds: number, maxConcurrentBuilds: number}}
 */
export function getBuildLimiterStats() {
  return buildSlotLimiter.getStats();
}
