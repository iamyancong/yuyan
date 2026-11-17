/**
 * 中央会话失效后的恢复编排（纯逻辑，依赖注入，无框架依赖）。
 * @description 1.3.25 把每一次 `401 session_invalid` 都当成「旧服务器令牌」处理：直接用 GitLab 凭据重新换票，
 * 失败或同一令牌再失效就登出。但访问令牌每 15 分钟会被定时器用 refresh 轮换，服务端轮换后旧令牌立即失效，
 * 轮换落盘前仍在路上的轮询请求会拿到 401——这是正常现象，不是会话过期。按旧逻辑处理会：
 * - 存储里的令牌已被定时器换掉时 `tryReestablishSilently` 返回 false → 直接登出；
 * - 静默换票会吊销设备上全部会话（含定时器刚换到的新令牌）；
 * - 换票得到的令牌下一次正常轮换时再遇到 401 → 命中「已续期过」→ 登出（约 26 分钟必现）。
 *
 * 新规则：
 * 1. 所有续期（定时刷新、启动刷新、失效恢复）串行执行，失效恢复先等进行中的续期落盘再判断；
 * 2. 失败请求用的令牌已不是当前令牌 → 已被轮换，忽略；
 * 3. 先用设备签名 refresh 轮换（不吊销其他会话），refresh 被拒才用 GitLab 凭据换票；
 * 4. 只有明确的身份拒绝（GitLab 令牌失效、设备被撤销/公钥不符）才重新登录；
 *    网络、超时、5xx 等临时错误保持登录；GitLab 地址不在服务端白名单单独提示，不当作登录过期。
 */

/** 恢复用到的最小账号状态。 */
export interface RecoverableSessionState {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: string;
  gitlabHost: string;
  gitlabToken: string;
}

/** 续期错误分类。 */
export type CentralAuthErrorKind = 'transient' | 'host_not_allowed' | 'rejected';

/** 服务端 GitLab 地址白名单拒绝码（#62）。 */
export const GITLAB_HOST_NOT_ALLOWED_CODE = 'gitlab_host_not_allowed';

/** 明确表示身份/设备不再可用的业务码。 */
const REJECTED_CODES = new Set([
  'session_expired',
  'session_invalid',
  'gitlab_token_invalid',
  'device_revoked',
  'device_key_mismatch',
  'device_signature_invalid',
  'device_signature_expired',
]);

/**
 * 对中央 refresh / exchange 的失败分类。
 * @param error requestCentral 抛出的错误（带 status、code）
 * @returns transient：网络、超时、5xx、409 重放、429 等可重试；host_not_allowed：白名单拒绝；rejected：身份被拒
 */
export function classifyCentralAuthError(error: unknown): CentralAuthErrorKind {
  const err = (error && typeof error === 'object' ? error : {}) as { status?: unknown; code?: unknown };
  const code = String(err.code ?? '');
  if (code === GITLAB_HOST_NOT_ALLOWED_CODE) return 'host_not_allowed';
  if (REJECTED_CODES.has(code)) return 'rejected';
  const status = Number(err.status);
  if (status === 401 || status === 403) return 'rejected';
  return 'transient';
}

/** 恢复结果。 */
export type CentralSessionRecoveryOutcome<S> =
  | { kind: 'rotated' }
  | { kind: 'recovered'; state: S; via: 'refresh' | 'exchange' }
  | { kind: 'transient'; error: unknown }
  | { kind: 'host_not_allowed'; error: unknown }
  | { kind: 'rejected'; error: unknown };

/** 恢复依赖。 */
export interface CentralSessionRecoveryDeps<S extends RecoverableSessionState> {
  /** 强制从安全存储读取当前账号。 */
  loadStored: () => Promise<S | null>;
  /** 用设备签名 + refresh 令牌轮换会话，失败时抛出带 status/code 的错误。 */
  refresh: (state: S) => Promise<S>;
  /** 用 GitLab 凭据重新换票（会吊销该设备旧会话），失败时抛错。 */
  exchange: (state: S) => Promise<S>;
  /** 保存新会话（在串行队列内完成，等待者看到的一定是落盘后的令牌）。 */
  save: (state: S) => Promise<void>;
  /** 当前时间（测试注入）。 */
  now?: () => number;
}

/**
 * 处理一次「失败请求用的令牌被中央判定失效」。
 * @param usedAccessToken 失败请求携带的访问令牌
 * @param deps 依赖
 * @returns 恢复结果
 */
export async function recoverCentralSession<S extends RecoverableSessionState>(
  usedAccessToken: string,
  deps: CentralSessionRecoveryDeps<S>,
): Promise<CentralSessionRecoveryOutcome<S>> {
  const now = deps.now || Date.now;
  const stored = await deps.loadStored();
  /** 已登出，或令牌已被定时器/其他恢复轮换：失败只是轮换窗口内的旧请求。 */
  if (!stored || !stored.accessToken || stored.accessToken !== usedAccessToken) return { kind: 'rotated' };

  if (stored.refreshToken && Date.parse(stored.refreshExpiresAt) > now()) {
    try {
      const next = await deps.refresh(stored);
      await deps.save(next);
      return { kind: 'recovered', state: next, via: 'refresh' };
    } catch (error) {
      const kind = classifyCentralAuthError(error);
      /** 临时错误不换票：换票会吊销会话，网络恢复后 refresh 仍然有效。 */
      if (kind === 'transient') return { kind: 'transient', error };
    }
  }

  if (!stored.gitlabHost || !stored.gitlabToken) {
    return { kind: 'rejected', error: Object.assign(new Error('本地没有可用于续期的 GitLab 凭据'), { code: 'no_gitlab_credential' }) };
  }
  try {
    const next = await deps.exchange(stored);
    await deps.save(next);
    return { kind: 'recovered', state: next, via: 'exchange' };
  } catch (error) {
    const kind = classifyCentralAuthError(error);
    if (kind === 'host_not_allowed') return { kind: 'host_not_allowed', error };
    if (kind === 'rejected') return { kind: 'rejected', error };
    return { kind: 'transient', error };
  }
}

/** 串行任务队列：保证同一时间只有一个续期在跑。 */
export interface SerialTaskQueue {
  /** 排队执行任务。 */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** 等待当前已排队的任务全部结束。 */
  idle(): Promise<void>;
}

/**
 * 创建串行任务队列。
 * @returns 队列
 */
export function createSerialTaskQueue(): SerialTaskQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task, task);
      tail = result.catch(() => undefined);
      return result;
    },
    async idle() {
      let current: Promise<unknown>;
      do {
        current = tail;
        await current;
      } while (current !== tail);
    },
  };
}
