import { onScopeDispose, ref, watch } from 'vue';
import { discoverServerNginx, type NginxDiscoveryResult } from '@/api/deploy';
import { hasDiscoveryCandidateKey } from '../presentationPolicy';

/** 智能发现 Hook 参数。 */
interface UseExistingNginxDiscoveryParams {
  serverId: () => number;
  open: () => boolean;
  useSudo: () => boolean;
}

/**
 * 获取 Nginx 发现接口错误文案。
 * @param error 请求错误
 * @returns 用户可读错误
 */
function getDiscoveryErrorMessage(error: any): string {
  return error?.response?.data?.error || error?.message || 'Nginx 扫描失败，可继续手动填写';
}

/**
 * 管理已有 Nginx 扫描状态与请求竞态。
 * @param params 响应式参数读取器
 * @returns 扫描状态与操作
 */
export function useExistingNginxDiscovery(params: UseExistingNginxDiscoveryParams) {
  const loading = ref(false);
  const result = ref<NginxDiscoveryResult | null>(null);
  const errorMessage = ref('');
  const selectedKey = ref('');
  const staleResult = ref(false);
  let requestSequence = 0;
  let abortController: AbortController | null = null;

  /** 取消当前扫描并使迟到响应失效。 */
  const cancelScan = () => {
    requestSequence += 1;
    abortController?.abort();
    abortController = null;
    loading.value = false;
  };

  /** 使用当前 sudo 选项扫描宿主机 Nginx。 */
  const scan = async (options: { clearResult?: boolean } = {}) => {
    const serverId = params.serverId();
    if (!params.open() || !serverId) return;
    cancelScan();
    if (options.clearResult) {
      result.value = null;
      selectedKey.value = '';
    } else if (result.value) {
      staleResult.value = true;
    }
    const sequence = requestSequence;
    abortController = new AbortController();
    loading.value = true;
    errorMessage.value = '';
    try {
      const response = await discoverServerNginx(serverId, params.useSudo(), abortController.signal);
      if (sequence !== requestSequence || !params.open()) return;
      const selectedStillExists = hasDiscoveryCandidateKey(response.runtimes, selectedKey.value);
      result.value = response;
      if (!selectedStillExists) selectedKey.value = '';
      staleResult.value = false;
    } catch (error: any) {
      if (sequence !== requestSequence || error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError') return;
      errorMessage.value = getDiscoveryErrorMessage(error);
      staleResult.value = Boolean(result.value);
    } finally {
      if (sequence === requestSequence) loading.value = false;
    }
  };

  watch(
    [params.open, params.serverId, params.useSudo],
    ([open, serverId, useSudo], [previousOpen, previousServerId, previousUseSudo]) => {
      if (!open || !serverId) {
        cancelScan();
        result.value = null;
        errorMessage.value = '';
        selectedKey.value = '';
        staleResult.value = false;
        return;
      }
      if (!previousOpen || previousServerId !== serverId || previousUseSudo !== useSudo) {
        staleResult.value = false;
        void scan({ clearResult: true });
      }
    },
    { immediate: true, flush: 'sync' },
  );

  onScopeDispose(cancelScan);

  return {
    errorMessage,
    loading,
    result,
    scan,
    selectedKey,
    staleResult,
  };
}
