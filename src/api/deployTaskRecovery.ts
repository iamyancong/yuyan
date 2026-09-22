import { isReadCancelled, recoverCentralRead, waitForReadRetry } from '../utils/centralReadRecovery';

/** 任务对账仅需要稳定标识对应的运行态与终态。 */
export interface ReconciledTask<T> {
  running: boolean;
  result: T | null;
  error: string | null;
}

/** 连接中断仍不能确定执行结果，保留只读重查入口，禁止自动重新发布。 */
export class DeployResultUnconfirmed extends Error {
  readonly code = 'DEPLOY_RESULT_UNCONFIRMED';
  /** 保留同一任务的只读重查方法，缺少任务标识时不猜测归属。 */
  constructor(public readonly resume?: () => Promise<unknown>) {
    super('连接中断，任务结果待确认；请核实结果，勿重复发布');
  }
}

/** 轮询同一任务直至得到真实终态，网络失败仅重试查询。 */
export async function reconcileDeployTask<T>(
  read: (signal: AbortSignal) => Promise<ReconciledTask<T>>,
  options: { signal?: AbortSignal; onConnection?: (recovering: boolean) => void; onSnapshot?: (snapshot: ReconciledTask<T>) => void } = {}
): Promise<T> {
  const signal = options.signal ?? new AbortController().signal;
  while (true) {
    let snapshot: ReconciledTask<T>;
    try {
      snapshot = await recoverCentralRead(read, { signal, onRetry: () => options.onConnection?.(true) });
    } catch (error) {
      if (signal.aborted || isReadCancelled(error)) throw error;
      throw new DeployResultUnconfirmed(() => reconcileDeployTask(read, options));
    }
    options.onConnection?.(false);
    options.onSnapshot?.(snapshot);
    if (!snapshot.running) {
      if (snapshot.error) throw Object.assign(new Error(snapshot.error), { code: 'DEPLOY_EXECUTION_FAILED' });
      if (snapshot.result) return snapshot.result;
      throw new DeployResultUnconfirmed(() => reconcileDeployTask(read, options));
    }
    await waitForReadRetry(1000, signal);
  }
}
