/**
 * 构建工作区闲置清理（#42）。
 * @description `<DEPLOY_DATA_DIR>/cache/workspaces/<目标ID>/<分支哈希>/` 是发布/后端构建复用的本地工作区（含 repo 与 node_modules），
 * 只增不减会把磁盘写满。本服务定期删除超过 N 天未使用的分支工作区：
 * - 正在使用（进程内租约）或在调度器中运行/排队的目标一律跳过；
 * - 删除前先在同一目录内原子改名到 `.trash-*`，再递归删除，避免与新任务的创建过程交错；
 * - 只处理工作区根目录内的真实目录，符号链接与越界路径一律跳过；
 * - 记录删除的目录与释放字节数。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEPLOY_DATA_DIR } from '../config/constants.mjs';

/** 工作区默认闲置天数 */
export const DEFAULT_WORKSPACE_IDLE_DAYS = 7;
/** 默认清理间隔（小时） */
export const DEFAULT_WORKSPACE_CLEANUP_INTERVAL_HOURS = 6;
/** 启动后首次清理的延迟 */
export const WORKSPACE_CLEANUP_INITIAL_DELAY_MS = 2 * 60 * 1000;
/** 工作区最近使用时间标记文件 */
export const WORKSPACE_USED_MARKER = '.yuyan-last-used';
/** 回收站目录前缀（位于工作区根目录内） */
const TRASH_PREFIX = '.trash-';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 默认工作区根目录。
 * @returns {string}
 */
export function resolveWorkspacesRoot() {
  return path.join(DEPLOY_DATA_DIR, 'cache', 'workspaces');
}

/**
 * 解析闲置天数，0 表示关闭清理，非法值回退默认值。
 * @param {string|undefined} raw 环境变量原值
 * @returns {number}
 */
export function parseWorkspaceIdleDays(raw = process.env.YUYAN_WORKSPACE_IDLE_DAYS) {
  const text = String(raw ?? '').trim();
  if (!text) return DEFAULT_WORKSPACE_IDLE_DAYS;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_WORKSPACE_IDLE_DAYS;
  return value;
}

/**
 * 解析清理间隔小时数，非法值回退默认值，最低 0.1 小时。
 * @param {string|undefined} raw 环境变量原值
 * @returns {number}
 */
export function parseWorkspaceCleanupIntervalHours(raw = process.env.YUYAN_WORKSPACE_CLEANUP_INTERVAL_HOURS) {
  const value = Number(String(raw ?? '').trim());
  if (!String(raw ?? '').trim() || !Number.isFinite(value) || value <= 0) return DEFAULT_WORKSPACE_CLEANUP_INTERVAL_HOURS;
  return Math.max(0.1, value);
}

/** @type {Map<string, number>} 目标 ID → 进程内正在使用的租约数 */
const activeLeases = new Map();
/** @type {Map<string, Promise<void>>} 目标 ID → 进行中的删除 */
const pendingRemovals = new Map();

/**
 * 在目标工作区租约内执行任务：执行期间该目标下的工作区不会被清理，
 * 若该目标正在被清理则等待清理完成后再开始。
 * @template T
 * @param {number|string} targetId 部署目标 ID
 * @param {() => Promise<T>} fn 任务
 * @returns {Promise<T>}
 */
export async function withTargetWorkspaceLease(targetId, fn) {
  const key = String(targetId);
  while (pendingRemovals.has(key)) {
    await pendingRemovals.get(key).catch(() => {});
  }
  activeLeases.set(key, (activeLeases.get(key) || 0) + 1);
  try {
    return await fn();
  } finally {
    const next = (activeLeases.get(key) || 1) - 1;
    if (next > 0) activeLeases.set(key, next);
    else activeLeases.delete(key);
  }
}

/**
 * 目标是否持有进程内租约。
 * @param {number|string} targetId 部署目标 ID
 * @returns {boolean}
 */
export function isTargetWorkspaceLeased(targetId) {
  return (activeLeases.get(String(targetId)) || 0) > 0;
}

/**
 * 写入工作区最近使用标记（失败不影响主流程）。
 * @param {string} workspaceRoot 分支工作区目录
 * @returns {Promise<void>}
 */
export async function touchWorkspaceUsed(workspaceRoot) {
  try {
    await fs.writeFile(path.join(workspaceRoot, WORKSPACE_USED_MARKER), `${new Date().toISOString()}\n`);
  } catch {
    // 标记仅用于闲置判断，写入失败时回退到目录 mtime
  }
}

/**
 * 判断 child 是否位于 root 内（不含 root 本身）。
 * @param {string} root 根目录（已 realpath）
 * @param {string} child 子路径
 * @returns {boolean}
 */
function isStrictlyInside(root, child) {
  const relative = path.relative(root, child);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * 读取分支工作区最近使用时间：取标记文件、目录本身、一级子项与 git 元数据的最大 mtime。
 * @param {string} dir 分支工作区目录
 * @returns {Promise<number>} 毫秒时间戳
 */
export async function readWorkspaceLastUsedMs(dir) {
  const candidates = [dir];
  const entries = await fs.readdir(dir).catch(() => []);
  for (const name of entries) candidates.push(path.join(dir, name));
  for (const name of ['HEAD', 'FETCH_HEAD', 'ORIG_HEAD', 'index']) candidates.push(path.join(dir, 'repo', '.git', name));
  let latest = 0;
  for (const candidate of candidates) {
    const stat = await fs.lstat(candidate).catch(() => null);
    if (stat && stat.mtimeMs > latest) latest = stat.mtimeMs;
  }
  return latest;
}

/**
 * 统计目录占用字节数（不跟随符号链接）。
 * @param {string} dir 目录
 * @returns {Promise<number>}
 */
export async function measureDirectoryBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat) continue;
    total += stat.size;
    if (!stat.isDirectory()) continue;
    const entries = await fs.readdir(current).catch(() => []);
    for (const name of entries) stack.push(path.join(current, name));
  }
  return total;
}

/**
 * 格式化字节数。
 * @param {number} bytes 字节
 * @returns {string}
 */
export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/**
 * 原子改名到回收站后递归删除。
 * @param {string} root 工作区根目录
 * @param {string} dir 待删除目录
 * @returns {Promise<void>}
 */
async function moveToTrashAndRemove(root, dir) {
  const trashPath = path.join(root, `${TRASH_PREFIX}${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  await fs.rename(dir, trashPath);
  await fs.rm(trashPath, { recursive: true, force: true });
}

/**
 * 清理闲置构建工作区。
 * @param {Object} [options] 选项
 * @param {string} [options.root] 工作区根目录
 * @param {number} [options.idleDays] 闲置天数，0 表示关闭
 * @param {number} [options.now] 当前时间（测试用）
 * @param {(targetId: string) => boolean} [options.isTargetBusy] 目标是否有运行/排队中的任务
 * @param {(message: string) => void} [options.log] 日志输出
 * @returns {Promise<{removed: Array<{path: string, bytes: number, idleDays: number}>, skipped: Array<{path: string, reason: string}>, freedBytes: number, disabled?: boolean}>}
 */
export async function cleanupIdleWorkspaces(options = {}) {
  const idleDays = options.idleDays ?? parseWorkspaceIdleDays();
  const log = options.log || ((message) => console.log(`[workspace-cleanup] ${message}`));
  const isTargetBusy = options.isTargetBusy || (() => false);
  const now = options.now ?? Date.now();
  const result = { removed: [], skipped: [], freedBytes: 0 };
  if (!(idleDays > 0)) return { ...result, disabled: true };

  const configuredRoot = options.root || resolveWorkspacesRoot();
  const rootStat = await fs.lstat(configuredRoot).catch(() => null);
  if (!rootStat) return result;
  if (!rootStat.isDirectory()) {
    log(`工作区根目录不是真实目录，跳过清理：${configuredRoot}`);
    return result;
  }
  const root = await fs.realpath(configuredRoot);
  const thresholdMs = idleDays * DAY_MS;

  const topEntries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of topEntries) {
    const entryPath = path.join(root, entry.name);
    if (entry.name.startsWith(TRASH_PREFIX)) {
      // 上次清理中断遗留的回收站目录
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const bytes = await measureDirectoryBytes(entryPath);
        await fs.rm(entryPath, { recursive: true, force: true }).catch(() => {});
        result.freedBytes += bytes;
        result.removed.push({ path: entryPath, bytes, idleDays: 0 });
        log(`已清理遗留回收站目录 ${entry.name}，释放 ${formatBytes(bytes)}`);
      }
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      result.skipped.push({ path: entryPath, reason: entry.isSymbolicLink() ? 'symlink' : 'not-directory' });
      continue;
    }
    const targetId = entry.name;
    const targetDir = entryPath;
    const branchEntries = await fs.readdir(targetDir, { withFileTypes: true }).catch(() => []);
    for (const branchEntry of branchEntries) {
      const branchDir = path.join(targetDir, branchEntry.name);
      if (branchEntry.isSymbolicLink() || !branchEntry.isDirectory()) {
        result.skipped.push({ path: branchDir, reason: branchEntry.isSymbolicLink() ? 'symlink' : 'not-directory' });
        continue;
      }
      const realBranchDir = await fs.realpath(branchDir).catch(() => '');
      if (!realBranchDir || !isStrictlyInside(root, realBranchDir) || path.dirname(path.dirname(realBranchDir)) !== root) {
        result.skipped.push({ path: branchDir, reason: 'outside-root' });
        continue;
      }
      const lastUsedMs = await readWorkspaceLastUsedMs(realBranchDir);
      const idleMs = now - lastUsedMs;
      if (idleMs < thresholdMs) continue;
      // 同步检查并登记删除，保证与 withTargetWorkspaceLease 之间没有交错窗口
      if (isTargetWorkspaceLeased(targetId) || pendingRemovals.has(targetId) || isTargetBusy(targetId)) {
        result.skipped.push({ path: realBranchDir, reason: 'in-use' });
        continue;
      }
      let finishRemoval;
      pendingRemovals.set(targetId, new Promise((resolve) => { finishRemoval = resolve; }));
      try {
        const bytes = await measureDirectoryBytes(realBranchDir);
        await moveToTrashAndRemove(root, realBranchDir);
        const idleDaysValue = Math.floor(idleMs / DAY_MS);
        result.freedBytes += bytes;
        result.removed.push({ path: realBranchDir, bytes, idleDays: idleDaysValue });
        log(`已清理闲置工作区 ${targetId}/${branchEntry.name}（${idleDaysValue} 天未使用），释放 ${formatBytes(bytes)}`);
      } catch (error) {
        result.skipped.push({ path: realBranchDir, reason: `error:${error?.code || error?.message || error}` });
        log(`清理工作区 ${targetId}/${branchEntry.name} 失败：${error?.message || error}`);
      } finally {
        pendingRemovals.delete(targetId);
        finishRemoval();
      }
    }
    // 目标下已无工作区时移除空目录；新任务会重新 mkdir -p
    if (!isTargetWorkspaceLeased(targetId) && !isTargetBusy(targetId)) {
      const remaining = await fs.readdir(targetDir).catch(() => null);
      if (remaining && remaining.length === 0) await fs.rmdir(targetDir).catch(() => {});
    }
  }
  if (result.removed.length > 0) {
    log(`本轮共清理 ${result.removed.length} 个工作区，释放 ${formatBytes(result.freedBytes)}（闲置阈值 ${idleDays} 天）`);
  }
  return result;
}

/**
 * 启动工作区闲置清理定时任务：启动后延迟首次执行，之后按间隔执行。
 * @param {Object} [options] 选项
 * @param {(targetId: string) => boolean} [options.isTargetBusy] 目标是否有运行/排队中的任务
 * @returns {() => void} 停止函数
 */
export function startWorkspaceCleanupScheduler(options = {}) {
  const idleDays = parseWorkspaceIdleDays();
  if (!(idleDays > 0)) {
    console.log('[workspace-cleanup] YUYAN_WORKSPACE_IDLE_DAYS=0，已关闭构建工作区闲置清理');
    return () => {};
  }
  const intervalMs = parseWorkspaceCleanupIntervalHours() * 60 * 60 * 1000;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await cleanupIdleWorkspaces({ idleDays, isTargetBusy: options.isTargetBusy });
    } catch (error) {
      console.warn('[workspace-cleanup] 工作区清理失败:', error);
    } finally {
      running = false;
    }
  };
  const initialTimer = setTimeout(run, options.initialDelayMs ?? WORKSPACE_CLEANUP_INITIAL_DELAY_MS);
  initialTimer.unref?.();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  console.log(`[workspace-cleanup] 构建工作区闲置清理已启动（闲置 ${idleDays} 天清理，间隔 ${intervalMs / 3600000} 小时）`);
  return () => {
    clearTimeout(initialTimer);
    clearInterval(timer);
  };
}
