/**
 * 本地构建子进程资源隔离与并发槽位调度服务。
 * @description 为独立服务器部署的本地重 CPU 阶段（依赖安装、前端 Vite/Webpack 打包、后端 Maven 编译与 OpenAPI 生成）提供：
 * 1. 构建并发槽位信号量（默认 3~5，与总任务并发 7 解耦，使 I/O 阶段与 CPU 构建阶段错峰并行）；
 * 2. 子进程 OS 低调度优先级（PRIORITY_BELOW_NORMAL），保障主服务 Express 事件循环优先获得 CPU 时间片；
 * 3. 构建子进程环境变量护栏（NODE_OPTIONS 堆上限、UV_THREADPOOL_SIZE 线程收敛、CI 非交互标志）。
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const cpuCount = Array.isArray(os.cpus()) && os.cpus().length > 0 ? os.cpus().length : 8;
const adaptiveDefaultSlots = Math.max(3, Math.min(5, Math.floor(cpuCount / 2)));

/** 默认本地同时执行的重型构建/安装任务槽位上限（默认处于 3~5 区间） */
export const DEFAULT_MAX_CONCURRENT_BUILDS = Math.max(
  1,
  Number(process.env.YUYAN_MAX_CONCURRENT_BUILDS || adaptiveDefaultSlots)
);

/** cgroup v1 无限制内存阈值（约 64TB，超出视为未设置容器限制） */
const CGROUP_UNLIMITED_BYTES_THRESHOLD = 64 * 1024 * 1024 * 1024 * 1024;

/**
 * 检测当前运行环境的有效物理内存上限（MB），优先识别容器 cgroup v2 / v1 内存限制并与 os.totalmem() 取较小值。
 * @param {Object} [options={}] 检测可选项（支持单测注入虚拟路径与宿主机内存）
 * @param {number} [options.hostTotalBytes] 宿主机总内存字节数（默认 os.totalmem()）
 * @param {string} [options.cgroupV2Path='/sys/fs/cgroup/memory.max'] cgroup v2 内存上限文件路径
 * @param {string} [options.cgroupV1Path='/sys/fs/cgroup/memory/memory.limit_in_bytes'] cgroup v1 内存上限文件路径
 * @returns {number} 有效总内存（MB，保底 512MB）
 */
export function detectSystemMemoryMb(options = {}) {
  const fallbackBytes = 8 * 1024 * 1024 * 1024;
  const rawHostBytes = Number(options.hostTotalBytes ?? os.totalmem?.() ?? 0);
  let effectiveBytes = Number.isFinite(rawHostBytes) && rawHostBytes > 0 ? rawHostBytes : fallbackBytes;

  const cgroupPaths = [
    options.cgroupV2Path ?? '/sys/fs/cgroup/memory.max',
    options.cgroupV1Path ?? '/sys/fs/cgroup/memory/memory.limit_in_bytes',
  ];

  for (const filePath of cgroupPaths) {
    if (!filePath) continue;
    try {
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (!content || content === 'max') continue;
      const limitBytes = Number(content);
      if (
        Number.isFinite(limitBytes) &&
        limitBytes > 0 &&
        limitBytes < CGROUP_UNLIMITED_BYTES_THRESHOLD
      ) {
        effectiveBytes = Math.min(effectiveBytes, limitBytes);
        break;
      }
    } catch {
      // 非 Linux 容器环境或文件不可读时忽略
    }
  }

  return Math.max(512, Math.floor(effectiveBytes / (1024 * 1024)));
}

const totalSystemMemoryMb = detectSystemMemoryMb();

/** 预留给操作系统、中心服务与 sshd 的物理内存（MB，默认 2048MB = 2GB） */
export const DEFAULT_BUILD_RESERVED_MEMORY_MB = Math.max(
  512,
  Number(process.env.YUYAN_BUILD_RESERVED_MEMORY_MB || 2048)
);

/** 本地构建全局内存预算池上限（MB，默认 = 有效总内存 - 系统预留内存，保底 1024MB 以免小内存机器挤占系统预留） */
export const DEFAULT_BUILD_MEMORY_POOL_MB = Math.max(
  1024,
  Number(
    process.env.YUYAN_BUILD_MEMORY_POOL_MB ||
      Math.max(1024, totalSystemMemoryMb - DEFAULT_BUILD_RESERVED_MEMORY_MB)
  )
);

const adaptiveDefaultHeapMb = Math.min(
  DEFAULT_BUILD_MEMORY_POOL_MB,
  Math.max(4096, Math.min(8192, Math.floor(totalSystemMemoryMb * 0.75)))
);

/** 默认单构建 Node 子进程最大老生代堆内存（MB，按 75% 物理内存处于 4GB~8GB 区间且不超过池上限，不人为压低单构建上限） */
export const DEFAULT_BUILD_MAX_OLD_SPACE_MB = Math.max(
  1024,
  Number(process.env.YUYAN_BUILD_MAX_OLD_SPACE_MB || adaptiveDefaultHeapMb)
);

/** 默认单构建在无历史峰值数据时的初始预算池预占额度（MB，默认 3072MB = 3GB） */
export const DEFAULT_BUILD_INITIAL_RESERVE_MB = Math.max(
  1024,
  Number(process.env.YUYAN_BUILD_INITIAL_RESERVE_MB || 3072)
);

/** 构建子进程树 RSS 内存峰值采样间隔（毫秒，默认 2000ms） */
export const DEFAULT_BUILD_RSS_SAMPLE_INTERVAL_MS = Math.max(
  50,
  Number(process.env.YUYAN_BUILD_RSS_SAMPLE_INTERVAL_MS || 2000)
);

/** OOM 自动重试时的期望老生代堆内存目标上限（MB，默认 8192MB，实际执行时与预算池上限取 min） */
export const FALLBACK_RETRY_MAX_OLD_SPACE_MB = Math.max(
  DEFAULT_BUILD_MAX_OLD_SPACE_MB,
  Number(process.env.YUYAN_BUILD_RETRY_MAX_OLD_SPACE_MB || 8192)
);

/** 默认 Maven 构建在内存预算池中的预占额度（MB） */
export const DEFAULT_MAVEN_BUILD_MEMORY_MB = Math.max(
  1024,
  Number(process.env.YUYAN_MAVEN_BUILD_MEMORY_MB || 2048)
);

/**
 * 将 MB 格式化为紧凑的 GB 数值文本（如 4096 -> "4"，2560 -> "2.5"）。
 * @param {number} memoryMb 内存大小（MB）
 * @returns {string} GB 文本
 */
export function formatMemoryGb(memoryMb) {
  const gb = Number(memoryMb || 0) / 1024;
  return String(Number(gb.toFixed(1)));
}

/**
 * 单次构建所需内存超过本机构建内存预算池上限时的快速失败错误。
 */
export class BuildMemoryBudgetExceededError extends Error {
  /**
   * @param {number} requestedMemoryMb 申请的内存大小（MB）
   * @param {number} maxMemoryMb 本机内存预算池上限（MB）
   */
  constructor(requestedMemoryMb, maxMemoryMb) {
    super(
      `本机内存不足以构建该项目（需要 ${formatMemoryGb(requestedMemoryMb)} GB，可用 ${formatMemoryGb(maxMemoryMb)} GB）`
    );
    this.name = 'BuildMemoryBudgetExceededError';
    this.code = 'BUILD_MEMORY_BUDGET_EXCEEDED';
    this.requestedMemoryMb = requestedMemoryMb;
    this.maxMemoryMb = maxMemoryMb;
  }
}

/**
 * 构建发生 Node OOM 后，受限于本机内存预算池上限无法继续扩容时的明确错误。
 */
export class BuildOomCannotExpandError extends Error {
  /**
   * @param {number} currentHeapMb 已发生 OOM 的当前堆大小（MB）
   * @param {number} maxPoolMemoryMb 本机内存预算池上限（MB）
   * @param {unknown} [cause] 原始 OOM 错误
   */
  constructor(currentHeapMb, maxPoolMemoryMb, cause) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause || '').trim();
    const baseMsg = `已 OOM（${formatMemoryGb(currentHeapMb)} GB），池上限只有 ${formatMemoryGb(maxPoolMemoryMb)} GB，无法扩容`;
    super(causeMsg ? `${baseMsg}（${causeMsg}）` : baseMsg);
    this.name = 'BuildOomCannotExpandError';
    this.code = 'BUILD_OOM_CANNOT_EXPAND';
    this.currentHeapMb = currentHeapMb;
    this.maxPoolMemoryMb = maxPoolMemoryMb;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

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
 * 解析 `ps -eo pid=,ppid=,pgid=,rss=` 输出文本，汇总以 `rootPid` 为根的整个进程树（含同进程组与递归子进程）的 RSS 内存（MB）。
 * @param {string} psOutput `ps` 命令标准输出
 * @param {number} rootPid 构建根进程 PID
 * @returns {number} 进程树总 RSS（MB）
 */
export function parsePsOutputToProcessTreeRssMb(psOutput, rootPid) {
  const targetPid = Number(rootPid || 0);
  if (!Number.isInteger(targetPid) || targetPid <= 0) return 0;

  const lines = String(psOutput || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  /** @type {Array<{pid: number, ppid: number, pgid: number, rssKb: number}>} */
  const processes = [];
  /** @type {Map<number, number[]>} */
  const childrenByPpid = new Map();

  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const pgid = Number(parts[2]);
    const rssKb = Number(parts[3]);
    if (!Number.isFinite(pid) || pid <= 0 || !Number.isFinite(rssKb) || rssKb < 0) continue;
    processes.push({ pid, ppid, pgid, rssKb });
    if (Number.isFinite(ppid) && ppid > 0) {
      const list = childrenByPpid.get(ppid) || [];
      list.push(pid);
      childrenByPpid.set(ppid, list);
    }
  }

  /** @type {Set<number>} */
  const matchedPids = new Set([targetPid]);
  const queue = [targetPid];
  while (queue.length > 0) {
    const current = queue.shift();
    const children = childrenByPpid.get(current) || [];
    for (const childPid of children) {
      if (!matchedPids.has(childPid)) {
        matchedPids.add(childPid);
        queue.push(childPid);
      }
    }
  }

  let totalRssKb = 0;
  for (const proc of processes) {
    if (matchedPids.has(proc.pid) || proc.pgid === targetPid) {
      totalRssKb += proc.rssKb;
    }
  }

  return totalRssKb > 0 ? Math.max(1, Math.ceil(totalRssKb / 1024)) : 0;
}

/**
 * 采样指定根进程及其子进程树（覆盖 sh -> pnpm/npm -> node/vite 等全部子进程）的当前总 RSS（MB）。
 * @param {number|undefined} rootPid 根进程 PID
 * @returns {Promise<number>} 进程树总 RSS（MB）
 */
export async function sampleProcessTreeRssMb(rootPid) {
  const numericPid = Number(rootPid || 0);
  if (!Number.isInteger(numericPid) || numericPid <= 0 || process.platform === 'win32') {
    return 0;
  }

  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-eo', 'pid=,ppid=,pgid=,rss='],
      { timeout: 1500, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error || !stdout) {
          resolve(0);
          return;
        }
        resolve(parsePsOutputToProcessTreeRssMb(stdout, numericPid));
      }
    );
  });
}

/**
 * 创建针对指定构建根进程树的周期性 RSS 内存峰值采样器（默认每 2 秒采样一次）。
 * @param {number|undefined} rootPid 构建根进程 PID
 * @param {Object} [options={}] 采样配置
 * @param {number} [options.intervalMs=DEFAULT_BUILD_RSS_SAMPLE_INTERVAL_MS] 采样间隔（ms，默认 2000ms）
 * @param {(pid: number) => Promise<number>|number} [options.sampleFn=sampleProcessTreeRssMb] 单次采样函数
 * @param {(peakRssMb: number, currentRssMb: number) => void} [options.onPeak] 每次采样后的峰值回调
 * @returns {{ sampleOnce: () => Promise<number>, stop: () => Promise<number>, getPeakRssMb: () => number }}
 */
export function createProcessTreeRssSampler(rootPid, options = {}) {
  const numericPid = Number(rootPid || 0);
  const intervalMs = Math.max(20, Number(options.intervalMs || DEFAULT_BUILD_RSS_SAMPLE_INTERVAL_MS));
  const sampleFn = options.sampleFn || sampleProcessTreeRssMb;
  const onPeak = options.onPeak;

  let peakRssMb = 0;
  let stopped = false;
  /** @type {Promise<number>|null} */
  let inFlightPromise = null;

  async function sampleOnce() {
    if (numericPid <= 0) return peakRssMb;
    if (inFlightPromise) return inFlightPromise;

    inFlightPromise = (async () => {
      try {
        const currentRssMb = Math.max(0, Math.ceil(Number((await sampleFn(numericPid)) || 0)));
        if (currentRssMb > peakRssMb) {
          peakRssMb = currentRssMb;
        }
        if (peakRssMb > 0) {
          onPeak?.(peakRssMb, currentRssMb);
        }
      } catch {
        // 忽略单次采样异常
      } finally {
        inFlightPromise = null;
      }
      return peakRssMb;
    })();

    return inFlightPromise;
  }

  let timer = null;
  if (numericPid > 0) {
    void sampleOnce();
    timer = setInterval(() => {
      if (!stopped) {
        void sampleOnce();
      }
    }, intervalMs);
    timer.unref?.();
  }

  async function stop() {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (inFlightPromise) {
      await inFlightPromise;
    }
    return peakRssMb;
  }

  function getPeakRssMb() {
    return peakRssMb;
  }

  return {
    sampleOnce,
    stop,
    getPeakRssMb,
  };
}

/**
 * 从构建命令与基础环境变量中提取显式指定的 `--max-old-space-size`（MB）。
 * @param {string} [command=''] 构建命令
 * @param {Record<string, string|undefined>} [baseEnv={}] 基础环境变量
 * @returns {number} 显式堆大小（MB），未指定时返回 0
 */
export function extractBuildMaxOldSpaceMb(command = '', baseEnv = {}) {
  const inlineEnv = command ? extractInlineCommandEnv(command).envVars : {};
  const inlineNodeOpts = String(inlineEnv.NODE_OPTIONS || '').trim();
  const baseNodeOpts = String(baseEnv.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? '').trim();

  const inlineMatch = inlineNodeOpts.match(/--max-old-space-size(?:=|\s+)(\d+)/);
  if (inlineMatch) return Number(inlineMatch[1] || 0);

  const cmdMatch = String(command || '').match(/--max-old-space-size(?:=|\s+)(\d+)/);
  if (cmdMatch) return Number(cmdMatch[1] || 0);

  const baseMatch = baseNodeOpts.match(/--max-old-space-size(?:=|\s+)(\d+)/);
  if (baseMatch) return Number(baseMatch[1] || 0);

  return 0;
}

/**
 * 解析单次 Node 构建注入给子进程的老生代堆上限（`--max-old-space-size`，MB）。
 * 保持 75% 物理内存规则（4GB~8GB 区间且不超过池上限），若命令显式指定或目标记忆了更高堆上限则取较大值。
 * @param {Object} [options={}] 解析参数
 * @param {string} [options.command=''] 构建命令
 * @param {Record<string, string|undefined>} [options.env={}] 基础环境变量
 * @param {number} [options.targetBuildMemoryMb=0] 部署目标配置或记忆的构建内存（MB）
 * @param {number} [options.defaultMaxOldSpaceMb=DEFAULT_BUILD_MAX_OLD_SPACE_MB] 默认单构建堆上限（MB）
 * @returns {number} 子进程堆上限（MB）
 */
export function resolveBuildHeapLimitMb(options = {}) {
  const explicitMb = extractBuildMaxOldSpaceMb(options.command, options.env);
  const rememberedMb = Math.max(0, Number(options.targetBuildMemoryMb || 0));
  const defaultHeapMb = Math.max(
    1024,
    Number(options.defaultMaxOldSpaceMb || DEFAULT_BUILD_MAX_OLD_SPACE_MB)
  );
  return Math.max(1024, defaultHeapMb, explicitMb, rememberedMb);
}

/**
 * 解析单次 Node 构建需要向内存预算池申请的预占内存（MB）。
 * 计算规则：`min(堆上限, max(3072, ceil(上次峰值 * 1.2), OOM 重试记住的值/手动指定预占值))`。
 * @param {Object} [options={}] 解析参数
 * @param {string} [options.command=''] 构建命令
 * @param {Record<string, string|undefined>} [options.env={}] 基础环境变量
 * @param {number} [options.targetBuildMemoryMb=0] 部署目标手动指定或 OOM 记忆的预占内存（MB，0 表示自动）
 * @param {number} [options.targetBuildPeakMb=0] 部署目标上次构建记录的实际 RSS 峰值（MB）
 * @param {number} [options.defaultMaxOldSpaceMb=DEFAULT_BUILD_MAX_OLD_SPACE_MB] 默认单构建堆上限（MB）
 * @param {number} [options.initialReserveMb=DEFAULT_BUILD_INITIAL_RESERVE_MB] 无历史数据时的基础预占值（MB，默认 3072）
 * @returns {number} 向内存预算池申请的预占内存（MB）
 */
export function resolveBuildMemoryRequirementMb(options = {}) {
  const explicitMb = extractBuildMaxOldSpaceMb(options.command, options.env);
  const rememberedMb = Math.max(0, Number(options.targetBuildMemoryMb || 0));
  const peakMb = Math.max(0, Number(options.targetBuildPeakMb ?? options.buildPeakMb ?? 0));
  const scaledPeakMb = peakMb > 0 ? Math.ceil(peakMb * 1.2) : 0;
  const baseReserveMb = Math.max(
    1024,
    Number(options.initialReserveMb || DEFAULT_BUILD_INITIAL_RESERVE_MB)
  );
  const heapLimitMb = resolveBuildHeapLimitMb(options);

  return Math.min(heapLimitMb, Math.max(baseReserveMb, scaledPeakMb, rememberedMb, explicitMb));
}

/**
 * 计算 Node OOM 自动重试时的扩容目标堆内存（MB），受限于本机构建内存预算池上限。
 * 当计算出的重试堆大小不大于当前已 OOM 的堆大小时，直接抛出明确错误。
 * @param {number} [initialHeapMb=DEFAULT_BUILD_MAX_OLD_SPACE_MB] 初次构建使用的堆内存（MB）
 * @param {number} [maxPoolMemoryMb=DEFAULT_BUILD_MEMORY_POOL_MB] 本机构建内存预算池上限（MB）
 * @param {unknown} [cause] 原始 OOM 错误对象
 * @returns {number} 扩容后的重试堆内存（MB）
 */
export function resolveOomRetryMaxOldSpaceMb(
  initialHeapMb = DEFAULT_BUILD_MAX_OLD_SPACE_MB,
  maxPoolMemoryMb = DEFAULT_BUILD_MEMORY_POOL_MB,
  cause = undefined
) {
  const current = Math.max(1024, Number(initialHeapMb || DEFAULT_BUILD_MAX_OLD_SPACE_MB));
  const poolCap = Math.max(1024, Number(maxPoolMemoryMb || DEFAULT_BUILD_MEMORY_POOL_MB));
  const desiredTargetMb =
    current < FALLBACK_RETRY_MAX_OLD_SPACE_MB ? FALLBACK_RETRY_MAX_OLD_SPACE_MB : current + 4096;
  const retryHeapMb = Math.min(desiredTargetMb, poolCap);
  if (retryHeapMb <= current) {
    throw new BuildOomCannotExpandError(current, poolCap, cause);
  }
  return retryHeapMb;
}

/**
 * 判断构建错误是否属于 Node.js V8 堆内存溢出（OOM）。
 * @param {unknown} error 构建捕获的错误
 * @returns {boolean}
 */
export function isNodeHeapOomError(error) {
  const errMsg = error instanceof Error ? error.message : String(error || '');
  return /JavaScript heap out of memory|Allocation failed - process out of memory|FatalProcessOutOfMemory/i.test(
    errMsg
  );
}

/**
 * 在构建槽位与内存预算池保护下执行构建，并在发生 Node OOM 时自动释放原预占配额、向预算池申请扩容配额后重试一次。
 * @param {Object} options 执行选项
 * @param {number} options.initialHeapMb 初次构建堆内存上限（MB）
 * @param {number} [options.initialReserveMb] 初次构建在内存池中的预占额度（MB，默认等于 initialHeapMb）
 * @param {boolean} [options.enableOomRetry=true] 是否启用 Node OOM 自动扩容重试
 * @param {number|string} [options.targetId] 关联部署目标 ID（用于运行指标观测）
 * @param {string} [options.label] 构建任务标签（用于运行指标观测）
 * @param {(slotContext: Object) => Promise<void>} [options.prepareInInitialSlot] 初次槽位内构建前的准备步骤（如安装依赖）
 * @param {(heapMb: number, isRetry: boolean, slotContext: Object) => Promise<void>} options.runBuild 实际构建回调
 * @param {Object} [options.limiter] 构建限制器实例（默认全局 buildSlotLimiter）
 * @param {AbortSignal} [options.signal] 取消信号
 * @param {(waitInfo: Object) => void} [options.onInitialWait] 初次等待回调
 * @param {(waitInfo: Object) => void} [options.onInitialPositionChange] 初次等待位次变化回调
 * @param {(waitInfo: Object, retryHeapMb: number) => void} [options.onRetryWait] 扩容重试等待回调
 * @param {(waitInfo: Object, retryHeapMb: number) => void} [options.onRetryPositionChange] 扩容重试等待位次变化回调
 * @param {(initialHeapMb: number, retryHeapMb: number, error: unknown) => void} [options.onBeforeRetry] 扩容重试开始前回调
 * @param {(retryHeapMb: number) => Promise<void>|void} [options.onRetrySuccess] 扩容重试成功回调
 * @param {(summary: {peakRssMb: number, initialReserveMb: number, usedHeapMb: number, retried: boolean, succeeded: boolean}) => Promise<void>|void} [options.onFinally] 构建结束（无论成功或失败）回调
 * @returns {Promise<{retried: boolean, usedHeapMb: number, peakRssMb: number, initialReserveMb: number}>}
 */
export async function executeBuildWithOomRetry(options) {
  const {
    initialHeapMb,
    initialReserveMb,
    enableOomRetry = true,
    targetId,
    label,
    prepareInInitialSlot,
    runBuild,
    limiter = buildSlotLimiter,
    signal,
    onInitialWait,
    onInitialPositionChange,
    onRetryWait,
    onRetryPositionChange,
    onBeforeRetry,
    onRetrySuccess,
    onFinally,
  } = options;

  const effectiveInitialReserveMb = Math.max(
    0,
    Number(initialReserveMb ?? initialHeapMb ?? DEFAULT_BUILD_INITIAL_RESERVE_MB)
  );
  let nodeOomBuildError = null;
  let maxObservedPeakRssMb = 0;
  let retried = false;
  let usedHeapMb = initialHeapMb;
  let succeeded = false;

  try {
    await limiter.withBuildSlot(
      async (slotContext) => {
        try {
          if (prepareInInitialSlot) {
            await prepareInInitialSlot(slotContext);
          }
          try {
            await runBuild(initialHeapMb, false, slotContext);
          } catch (buildError) {
            if (!enableOomRetry || !isNodeHeapOomError(buildError)) {
              throw buildError;
            }
            nodeOomBuildError = buildError;
          }
        } finally {
          maxObservedPeakRssMb = Math.max(
            maxObservedPeakRssMb,
            Number(slotContext?.getPeakRssMb?.() || 0)
          );
        }
      },
      {
        memoryMb: effectiveInitialReserveMb,
        heapLimitMb: initialHeapMb,
        targetId,
        label,
        signal,
        onWait: onInitialWait,
        onPositionChange: onInitialPositionChange,
      }
    );

    if (!nodeOomBuildError) {
      succeeded = true;
      return {
        retried: false,
        usedHeapMb: initialHeapMb,
        peakRssMb: maxObservedPeakRssMb,
        initialReserveMb: effectiveInitialReserveMb,
      };
    }

    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error(String(signal.reason || '构建任务已取消'));
    }

    const retryHeapMb = resolveOomRetryMaxOldSpaceMb(
      initialHeapMb,
      limiter.maxMemoryMb,
      nodeOomBuildError
    );

    retried = true;
    usedHeapMb = retryHeapMb;
    onBeforeRetry?.(initialHeapMb, retryHeapMb, nodeOomBuildError);

    await limiter.withBuildSlot(
      async (slotContext) => {
        try {
          await runBuild(retryHeapMb, true, slotContext);
        } finally {
          maxObservedPeakRssMb = Math.max(
            maxObservedPeakRssMb,
            Number(slotContext?.getPeakRssMb?.() || 0)
          );
        }
      },
      {
        memoryMb: retryHeapMb,
        heapLimitMb: retryHeapMb,
        targetId,
        label,
        isOomRetry: true,
        signal,
        onWait: onRetryWait ? (info) => onRetryWait(info, retryHeapMb) : undefined,
        onPositionChange: onRetryPositionChange
          ? (info) => onRetryPositionChange(info, retryHeapMb)
          : undefined,
      }
    );

    if (onRetrySuccess) {
      await onRetrySuccess(retryHeapMb);
    }

    succeeded = true;
    return {
      retried: true,
      usedHeapMb: retryHeapMb,
      peakRssMb: maxObservedPeakRssMb,
      initialReserveMb: effectiveInitialReserveMb,
    };
  } finally {
    if (onFinally) {
      try {
        await onFinally({
          peakRssMb: maxObservedPeakRssMb,
          initialReserveMb: effectiveInitialReserveMb,
          usedHeapMb,
          retried,
          succeeded,
        });
      } catch (finallyError) {
        console.warn('[build-isolation-service] 执行构建结束回调失败:', finallyError);
      }
    }
  }
}

/**
 * 将构建槽位/内存预算等待快照格式化为前端进度阶段文案与日志文案。
 * @param {Object} [waitInfo={}] 等待快照
 * @returns {{stageKey: 'waiting-build-slot', message: string, detail: string, logMessage: string}}
 */
export function formatBuildWaitStage(waitInfo = {}) {
  const waitingPosition = Math.max(1, Number(waitInfo.waitingPosition || 1));
  const waitingReason = waitInfo.waitingReason || 'slot';
  const activeBuilds = Number(waitInfo.activeBuilds || 0);
  const maxConcurrentBuilds = Number(waitInfo.maxConcurrentBuilds || DEFAULT_MAX_CONCURRENT_BUILDS);
  const requestedMemoryMb = Number(waitInfo.requestedMemoryMb || DEFAULT_BUILD_MAX_OLD_SPACE_MB);
  const availableMemoryMb = Number(waitInfo.availableMemoryMb || 0);
  const maxMemoryMb = Number(waitInfo.maxMemoryMb || DEFAULT_BUILD_MEMORY_POOL_MB);

  if (waitingReason === 'memory' || waitingReason === 'oom-retry') {
    const reqGb = formatMemoryGb(requestedMemoryMb);
    const availGb = formatMemoryGb(availableMemoryMb);
    const maxGb = formatMemoryGb(maxMemoryMb);
    const message = '等待构建资源（内存）…';
    const detail = `当前构建排第 ${waitingPosition} 位 · 需 ${reqGb}GB 内存，预算池可用 ${availGb}/${maxGb}GB`;
    const logMessage =
      waitingReason === 'oom-retry'
        ? `当前构建内存预算池或扩容重试通道繁忙（需 ${reqGb}GB，可用 ${availGb}/${maxGb}GB），正在等待构建内存资源（排第 ${waitingPosition} 位）...`
        : `当前本机可用构建内存不足（需 ${reqGb}GB，预算池可用 ${availGb}/${maxGb}GB），正在等待构建内存释放（排第 ${waitingPosition} 位）...`;
    return { stageKey: 'waiting-build-slot', message, detail, logMessage };
  }

  const message = '等待构建资源（槽位）…';
  const detail = `当前构建排第 ${waitingPosition} 位 · 活跃构建 ${activeBuilds}/${maxConcurrentBuilds}`;
  const logMessage = `当前本地构建槽位已满（${activeBuilds}/${maxConcurrentBuilds}），正在等待空闲构建槽位（排第 ${waitingPosition} 位）...`;
  return { stageKey: 'waiting-build-slot', message, detail, logMessage };
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
    const existingHeapMatch = existingNodeOptions.match(/--max-old-space-size(?:=|\s+)(\d+)/);
    if (!existingHeapMatch) {
      const cmdHeapMatch = String(options.command || '').match(/--max-old-space-size(?:=|\s+)(\d+)/);
      const heapMb = Math.max(
        512,
        Number(options.maxOldSpaceMb || (cmdHeapMatch ? cmdHeapMatch[1] : 0) || DEFAULT_BUILD_MAX_OLD_SPACE_MB)
      );
      const heapFlag = `--max-old-space-size=${heapMb}`;
      merged.NODE_OPTIONS = existingNodeOptions ? `${existingNodeOptions} ${heapFlag}` : heapFlag;
    } else if (options.maxOldSpaceMb && Number(options.maxOldSpaceMb) > Number(existingHeapMatch[1])) {
      // 当调用方（如 OOM 扩容重试或目标记忆堆上限）要求更高堆内存时，覆盖较低的旧参数
      const targetHeapMb = Math.max(512, Number(options.maxOldSpaceMb));
      merged.NODE_OPTIONS = existingNodeOptions.replace(
        /--max-old-space-size(?:=|\s+)\d+/g,
        `--max-old-space-size=${targetHeapMb}`
      );
    }
  }

  return merged;
}

/**
 * 创建本地构建并发槽位与内存预算池限制器（带权信号量）。
 * @param {Object} [options={}] 配置参数
 * @param {number} [options.maxConcurrent] 最大并发构建槽位数（默认 3~5，第二道防 CPU 打死上限）
 * @param {number} [options.maxMemoryMb] 构建内存预算池总上限（MB，默认 totalmem - 2GB）
 * @param {number} [options.totalSystemMemoryMb] 宿主机总物理内存（MB）
 * @param {number} [options.reservedSystemMemoryMb] 宿主机系统预留内存（MB，默认 2048MB）
 * @param {number} [options.defaultMemoryMb] 未显式传 memoryMb 时的默认单构建预占内存（MB，默认 3072MB）
 * @param {number} [options.maxConcurrentOomRetries] 同一时刻允许并发执行的 OOM 扩容重试任务数（默认 1）
 * @returns {Object} 构建槽位与内存预算限制器实例
 */
export function createBuildSlotLimiter(options = {}) {
  const maxConcurrent = Math.max(1, Number(options.maxConcurrent || DEFAULT_MAX_CONCURRENT_BUILDS));
  const configuredTotalMemoryMb = Math.max(1024, Number(options.totalSystemMemoryMb || totalSystemMemoryMb));
  const reservedSystemMemoryMb = Math.max(
    0,
    Number(options.reservedSystemMemoryMb ?? DEFAULT_BUILD_RESERVED_MEMORY_MB)
  );
  const defaultMemoryMb = Math.max(
    0,
    Number(options.defaultMemoryMb ?? DEFAULT_BUILD_INITIAL_RESERVE_MB)
  );
  const maxConcurrentOomRetries = Math.max(1, Number(options.maxConcurrentOomRetries || 1));

  const computedPoolMb = options.totalSystemMemoryMb
    ? Math.max(1024, configuredTotalMemoryMb - reservedSystemMemoryMb)
    : DEFAULT_BUILD_MEMORY_POOL_MB;
  const maxMemoryMb = Math.max(
    1024,
    Number(
      options.maxMemoryMb ||
        (options.maxConcurrent && !options.totalSystemMemoryMb
          ? Math.max(computedPoolMb, maxConcurrent * defaultMemoryMb)
          : computedPoolMb)
    )
  );

  let activeCount = 0;
  let usedMemoryMb = 0;
  let activeOomRetries = 0;
  let nextBuildSeq = 1;
  const maxRecentBuilds = 20;
  /** @type {Map<number, Object>} */
  const activeBuildItems = new Map();
  /** @type {Array<Object>} */
  const recentBuilds = [];
  /**
   * @type {Array<{
   *   memoryMb: number,
   *   isOomRetry: boolean,
   *   grant: () => void,
   *   reject: (err: Error) => void,
   *   cleanup: () => void,
   *   onPositionChange?: (info: Object) => void
   * }>}
   */
  const waitQueue = [];

  /**
   * 获取当前构建槽位与内存预算池运行统计（含活跃与近期构建的预占值与实际峰值）。
   */
  function getStats() {
    return {
      activeBuilds: activeCount,
      waitingBuilds: waitQueue.length,
      maxConcurrentBuilds: maxConcurrent,
      usedMemoryMb,
      availableMemoryMb: Math.max(0, maxMemoryMb - usedMemoryMb),
      maxMemoryMb,
      reservedSystemMemoryMb,
      totalSystemMemoryMb: configuredTotalMemoryMb,
      activeOomRetries,
      maxConcurrentOomRetries,
      activeBuildDetails: Array.from(activeBuildItems.values()).map((item) => ({ ...item })),
      recentBuilds: recentBuilds.map((item) => ({ ...item })),
    };
  }

  /**
   * 判断当前资源池是否满足指定构建请求。
   * @param {number} requestedMemoryMb 申请的内存（MB）
   * @param {boolean} isOomRetry 是否为 OOM 扩容重试
   * @returns {boolean}
   */
  function canGrantNow(requestedMemoryMb, isOomRetry) {
    if (activeCount >= maxConcurrent) return false;
    if (isOomRetry && activeOomRetries >= maxConcurrentOomRetries) return false;
    if (usedMemoryMb + requestedMemoryMb > maxMemoryMb) return false;
    return true;
  }

  /**
   * 计算等待原因（内存不足 / OOM 重试限流 / 槽位已满）。
   * @param {number} requestedMemoryMb 申请的内存（MB）
   * @param {boolean} isOomRetry 是否为 OOM 扩容重试
   * @returns {'memory' | 'oom-retry' | 'slot'}
   */
  function resolveWaitingReason(requestedMemoryMb, isOomRetry) {
    if (activeCount >= maxConcurrent) {
      return 'slot';
    }
    if (isOomRetry && activeOomRetries >= maxConcurrentOomRetries) {
      return 'oom-retry';
    }
    if (usedMemoryMb + requestedMemoryMb > maxMemoryMb) {
      return 'memory';
    }
    return 'slot';
  }

  /**
   * 构造等待队列项的状态快照。
   * @param {{memoryMb: number, isOomRetry: boolean}} item 等待项
   * @param {number} waitingPosition 队列位置（从 1 开始）
   */
  function buildWaitSnapshot(item, waitingPosition) {
    return {
      waitingPosition,
      activeBuilds: activeCount,
      maxConcurrentBuilds: maxConcurrent,
      waitingReason: resolveWaitingReason(item.memoryMb, item.isOomRetry),
      requestedMemoryMb: item.memoryMb,
      usedMemoryMb,
      availableMemoryMb: Math.max(0, maxMemoryMb - usedMemoryMb),
      maxMemoryMb,
    };
  }

  /**
   * 广播等待队列中剩余任务的最新排队位次与等待原因。
   */
  function notifyWaitQueuePositions() {
    waitQueue.forEach((entry, index) => {
      try {
        entry.onPositionChange?.(buildWaitSnapshot(entry, index + 1));
      } catch {}
    });
  }

  /**
   * 按 FIFO 顺序尝试唤醒等待队列头部可满足当前槽位与内存预算的任务，并刷新剩余等待任务的位次。
   */
  function drainWaitQueue() {
    while (waitQueue.length > 0) {
      const head = waitQueue[0];
      if (!head) break;
      if (!canGrantNow(head.memoryMb, head.isOomRetry)) {
        break;
      }
      waitQueue.shift();
      head.cleanup();
      activeCount += 1;
      usedMemoryMb += head.memoryMb;
      if (head.isOomRetry) {
        activeOomRetries += 1;
      }
      head.grant();
    }

    if (waitQueue.length > 0) {
      notifyWaitQueuePositions();
    }
  }

  /**
   * 释放构建槽位与内存配额，并按 FIFO 顺序唤醒队列中可满足预算的等待任务。
   * @param {number} acquiredMemoryMb 归还的内存（MB）
   * @param {boolean} isOomRetry 是否为 OOM 扩容重试
   */
  function releaseSlot(acquiredMemoryMb, isOomRetry) {
    activeCount = Math.max(0, activeCount - 1);
    usedMemoryMb = Math.max(0, usedMemoryMb - acquiredMemoryMb);
    if (isOomRetry) {
      activeOomRetries = Math.max(0, activeOomRetries - 1);
    }

    drainWaitQueue();
  }

  /**
   * 申请构建槽位与内存预算，在槽位内执行异步构建函数，并在完成后自动归还槽位与内存。
   * @template T
   * @param {(slotContext: {buildId: number, reservedMemoryMb: number, reportPeakRssMb: (rssMb: number) => number, getPeakRssMb: () => number}) => Promise<T>} runner 构建执行函数
   * @param {Object} [slotOptions={}] 槽位与内存申请选项
   * @param {number} [slotOptions.memoryMb] 预占内存大小（MB）
   * @param {number} [slotOptions.heapLimitMb] 子进程堆上限（MB）
   * @param {number|string} [slotOptions.targetId] 关联部署目标 ID
   * @param {string} [slotOptions.label] 构建标签
   * @param {boolean} [slotOptions.isOomRetry=false] 是否为 OOM 扩容重试
   * @param {AbortSignal} [slotOptions.signal] 取消信号
   * @param {(info: Object) => void} [slotOptions.onWait] 进入等待队列时的回调
   * @param {(info: Object) => void} [slotOptions.onPositionChange] 等待位次或等待原因变化时的回调
   * @returns {Promise<T>}
   */
  async function withBuildSlot(runner, slotOptions = {}) {
    const { signal, onWait, onPositionChange } = slotOptions;
    const requestedMemoryMb = Math.max(0, Number(slotOptions.memoryMb ?? defaultMemoryMb));
    const isOomRetry = Boolean(slotOptions.isOomRetry);

    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || '构建任务已取消'));
    }

    // 单次需求超过本机总内存预算池时直接快速失败，避免无限排队
    if (requestedMemoryMb > maxMemoryMb) {
      throw new BuildMemoryBudgetExceededError(requestedMemoryMb, maxMemoryMb);
    }

    if (waitQueue.length === 0 && canGrantNow(requestedMemoryMb, isOomRetry)) {
      activeCount += 1;
      usedMemoryMb += requestedMemoryMb;
      if (isOomRetry) {
        activeOomRetries += 1;
      }
    } else {
      await new Promise((resolve, reject) => {
        const waitingPosition = waitQueue.length + 1;
        const itemDescriptor = { memoryMb: requestedMemoryMb, isOomRetry };
        try {
          onWait?.(buildWaitSnapshot(itemDescriptor, waitingPosition));
        } catch {}

        const cleanup = () => {
          signal?.removeEventListener?.('abort', handleAbort);
        };

        const entry = {
          memoryMb: requestedMemoryMb,
          isOomRetry,
          grant: resolve,
          reject,
          cleanup,
          onPositionChange,
        };

        function handleAbort() {
          cleanup();
          const idx = waitQueue.indexOf(entry);
          if (idx >= 0) {
            waitQueue.splice(idx, 1);
            drainWaitQueue();
          }
          const abortReason = signal?.reason;
          reject(abortReason instanceof Error ? abortReason : new Error(String(abortReason || '构建任务已取消')));
        }

        signal?.addEventListener?.('abort', handleAbort, { once: true });
        waitQueue.push(entry);
      });
    }

    const buildId = nextBuildSeq++;
    const buildRecord = {
      buildId,
      targetId: slotOptions.targetId ?? null,
      label: slotOptions.label ?? null,
      reservedMemoryMb: requestedMemoryMb,
      heapLimitMb: Number(slotOptions.heapLimitMb || requestedMemoryMb),
      peakRssMb: 0,
      isOomRetry,
      startedAt: new Date().toISOString(),
    };
    activeBuildItems.set(buildId, buildRecord);

    const slotContext = {
      buildId,
      reservedMemoryMb: requestedMemoryMb,
      reportPeakRssMb(rssMb) {
        const numeric = Math.max(0, Math.ceil(Number(rssMb || 0)));
        if (numeric > buildRecord.peakRssMb) {
          buildRecord.peakRssMb = numeric;
        }
        return buildRecord.peakRssMb;
      },
      getPeakRssMb() {
        return buildRecord.peakRssMb;
      },
    };

    try {
      return await runner(slotContext);
    } finally {
      activeBuildItems.delete(buildId);
      recentBuilds.unshift({
        ...buildRecord,
        finishedAt: new Date().toISOString(),
      });
      if (recentBuilds.length > maxRecentBuilds) {
        recentBuilds.length = maxRecentBuilds;
      }
      releaseSlot(requestedMemoryMb, isOomRetry);
    }
  }

  return {
    maxConcurrent,
    maxMemoryMb,
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
 * 获取全局构建槽位与内存预算池实时统计。
 */
export function getBuildLimiterStats() {
  return buildSlotLimiter.getStats();
}
