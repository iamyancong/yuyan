import { ref } from 'vue';
import { DeployResultUnconfirmed } from '@/api/deployTaskRecovery';
import type { DeployTaskResult } from '@/api/deploy';

/** 管理任务连接恢复与结果待确认状态，不能将连接错误解释为执行失败。 */
export function useDeployConnectionState(params: {
  state: { title: string; detail: string; running: boolean };
  onResult: (result: DeployTaskResult) => void;
  onFailure: (error: unknown) => void;
}) {
  const reconnecting = ref(false);
  const unconfirmed = ref(false);
  const verifying = ref(false);
  const resume = ref<(() => Promise<unknown>) | undefined>();
  let generation = 0;
  let previousDetail = '';

  /** 标记连接恢复，不修改执行日志和已确认的终态。 */
  const onConnection = (recovering: boolean) => {
    if (recovering && !reconnecting.value) previousDetail = params.state.detail;
    if (recovering) params.state.detail = '连接暂时中断，正在核实任务状态';
    else if (reconnecting.value) params.state.detail = previousDetail || params.state.detail;
    reconnecting.value = recovering;
  };

  /** 消费待确认异常，其余业务失败交由原有执行逻辑处理。 */
  const handleError = (error: unknown): boolean => {
    if (!(error instanceof DeployResultUnconfirmed)) return false;
    reconnecting.value = false;
    unconfirmed.value = true;
    resume.value = error.resume;
    params.state.title = '任务结果待确认';
    params.state.detail = error.message;
    return true;
  };

  /** 用户主动重查同一个任务，仅发起只读查询。 */
  const verify = async () => {
    if (!resume.value || verifying.value) return;
    const sequence = generation;
    verifying.value = true;
    try {
      const result = await resume.value();
      if (sequence !== generation) return;
      unconfirmed.value = false;
      resume.value = undefined;
      params.onResult(result as DeployTaskResult);
    } catch (error) {
      if (sequence !== generation) return;
      if (!handleError(error)) {
        unconfirmed.value = false;
        resume.value = undefined;
        params.onFailure(error);
      }
    } finally {
      if (sequence === generation) {
        verifying.value = false;
        reconnecting.value = false;
      }
    }
  };

  /** 切换任务或身份时丢弃旧查询的回调。 */
  const reset = () => {
    generation += 1;
    previousDetail = '';
    reconnecting.value = false;
    unconfirmed.value = false;
    verifying.value = false;
    resume.value = undefined;
  };

  return { reconnecting, unconfirmed, verifying, resume, onConnection, handleError, verify, reset };
}
