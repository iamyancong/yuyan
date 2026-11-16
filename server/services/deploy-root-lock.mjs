/**
 * 同服务器部署目录的进程内等待型互斥锁（#61）。
 * @description 远程写入（上传、清理、切换、失败恢复、回滚）按「物理服务器 + 最外层部署目录」互斥。
 * 同一进程内的任务在这里按 FIFO 排队等待，不再撞上远程 `.yuyan-deploy.lock` 直接失败；
 * 等待可随任务停止信号取消，持有者在 finally 中释放。每个任务只取一把锁，
 * 父子/兄弟目标解析出的最外层目录一致，因此不会出现交叉等待导致的死锁。
 */

/** @type {Map<string, {holder: Object|null, waiters: Array<Object>}>} */
const lockStates = new Map();

/**
 * 生成目录锁键：物理服务器（host:port，缺失时回退 serverId）+ 规范化后的最外层目录。
 * @param {{host?: string, port?: number|string, id?: number|string, serverId?: number|string}} server 服务器信息
 * @param {string} lockRoot 最外层部署目录（真实路径）
 * @returns {string} 锁键
 */
export function buildDeployRootLockKey(server, lockRoot) {
  const host = String(server?.host || '').trim().toLowerCase();
  const serverKey = host
    ? `${host}:${Number(server?.port || 22)}`
    : `server#${Number(server?.serverId ?? server?.id ?? 0)}`;
  const root = String(lockRoot || '').trim().replace(/\/+$/, '') || '/';
  return `${serverKey}|${root}`;
}

/**
 * 读取某个锁键当前持有者（只读快照，供诊断与测试）。
 * @param {string} key 锁键
 * @returns {Object|null} 持有者信息
 */
export function getDeployRootLockHolder(key) {
  return lockStates.get(key)?.holder?.owner || null;
}

/**
 * 读取某个锁键当前等待数量。
 * @param {string} key 锁键
 * @returns {number} 等待数
 */
export function getDeployRootLockWaitingCount(key) {
  return lockStates.get(key)?.waiters.length || 0;
}

/**
 * 获取目录锁；被占用时 FIFO 等待。
 * @param {string} key 锁键（buildDeployRootLockKey）
 * @param {Object} [options] 选项
 * @param {Object} [options.owner] 持有者信息（projectName、targetId、recordId、operator 等），用于等待提示
 * @param {AbortSignal} [options.signal] 停止信号，触发后放弃等待并抛出 signal.reason
 * @param {(info: {holder: Object|null, position: number}) => void} [options.onWait] 进入等待或前序持有者变化时回调
 * @returns {Promise<() => void>} 释放函数（幂等）
 */
export function acquireDeployRootLock(key, options = {}) {
  const { owner = {}, signal, onWait } = options;
  if (signal?.aborted) {
    return Promise.reject(signal.reason || createAbortError());
  }
  let state = lockStates.get(key);
  if (!state) {
    state = { holder: null, waiters: [] };
    lockStates.set(key, state);
  }

  if (!state.holder) {
    return Promise.resolve(grant(key, state, owner));
  }

  return new Promise((resolve, reject) => {
    const waiter = { owner, resolve, reject, onWait, signal, onAbort: null };
    waiter.onAbort = () => {
      const index = state.waiters.indexOf(waiter);
      if (index >= 0) state.waiters.splice(index, 1);
      notifyWaiters(state);
      reject(signal.reason || createAbortError());
    };
    signal?.addEventListener?.('abort', waiter.onAbort, { once: true });
    state.waiters.push(waiter);
    safeNotify(waiter, state.holder?.owner || null, state.waiters.length);
  });
}

/**
 * 在目录锁内执行函数，结束后（含异常）自动释放。
 * @template T
 * @param {string} key 锁键
 * @param {() => Promise<T>} fn 执行函数
 * @param {Object} [options] 同 acquireDeployRootLock
 * @returns {Promise<T>}
 */
export async function withDeployRootLock(key, fn, options = {}) {
  const release = await acquireDeployRootLock(key, options);
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * 把锁交给指定持有者并返回幂等释放函数。
 * @param {string} key 锁键
 * @param {{holder: Object|null, waiters: Array<Object>}} state 锁状态
 * @param {Object} owner 持有者信息
 * @returns {() => void}
 */
function grant(key, state, owner) {
  const holder = { owner, released: false };
  state.holder = holder;
  return () => {
    if (holder.released) return;
    holder.released = true;
    if (state.holder !== holder) return;
    state.holder = null;
    const next = state.waiters.shift();
    if (!next) {
      lockStates.delete(key);
      return;
    }
    next.signal?.removeEventListener?.('abort', next.onAbort);
    next.resolve(grant(key, state, next.owner));
    notifyWaiters(state);
  };
}

/**
 * 通知剩余等待者新的持有者与名次。
 * @param {{holder: Object|null, waiters: Array<Object>}} state 锁状态
 */
function notifyWaiters(state) {
  state.waiters.forEach((waiter, index) => safeNotify(waiter, state.holder?.owner || null, index + 1));
}

/**
 * 调用等待回调并吞掉回调异常，避免影响锁状态。
 * @param {Object} waiter 等待者
 * @param {Object|null} holder 当前持有者
 * @param {number} position 等待名次
 */
function safeNotify(waiter, holder, position) {
  try {
    waiter.onWait?.({ holder, position });
  } catch {}
}

/**
 * 创建默认中止错误。
 * @returns {Error}
 */
function createAbortError() {
  const error = new Error('等待目录锁时任务已停止');
  error.name = 'AbortError';
  return error;
}

/**
 * 格式化等待目录锁的阶段说明。
 * @param {{holder: Object|null, position: number, lockRoot?: string, hint?: string}} info 等待信息
 * @returns {{message: string, detail: string}}
 */
export function formatDeployRootLockWait(info = {}) {
  const holderName = String(info.holder?.projectName || '').trim() || (info.holder?.targetId ? `目标 #${info.holder.targetId}` : '其他发布任务');
  const operator = String(info.holder?.operator || '').trim();
  const action = String(info.holder?.actionLabel || '').trim();
  const position = Math.max(1, Number(info.position || 1));
  const message = `等待同服务器目录锁…（被「${holderName}」占用）`;
  const parts = [`被「${holderName}」${operator ? `（${operator}${action ? ` ${action}` : ''}）` : ''}占用`];
  if (info.lockRoot) parts.push(`目录 ${info.lockRoot}`);
  if (position > 1) parts.push(`前面还有 ${position - 1} 个任务`);
  if (info.hint) parts.push(info.hint);
  return { message, detail: parts.join(' · ') };
}
