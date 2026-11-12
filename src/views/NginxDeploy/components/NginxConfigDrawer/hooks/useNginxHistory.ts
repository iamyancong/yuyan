import { onScopeDispose, ref, shallowRef, watch } from 'vue';
import message from 'ant-design-vue/es/message';
import {
  listNginxConfHistory,
  readNginxConf,
  readNginxConfHistoryItem,
  type NginxConfHistoryItem,
} from '@/api/deploy';
import { getErrorMessage } from '../constant';
import { downloadTextFile } from '../utils/downloadText';
import { sanitizeDownloadName } from '../historyPolicy';

/** 历史版本对比状态 */
export interface NginxHistoryCompareState {
  item: NginxConfHistoryItem;
  historyContent: string;
  currentContent: string;
  currentSha256: string;
  currentFetchedAt: string;
  loading: boolean;
}

/**
 * Nginx 配置历史版本列表、对比与下载 Hook。
 * @param props 组件属性（targetId）
 */
export function useNginxHistory(props: { targetId: number | null }) {
  const historyOpen = ref(false);
  const items = ref<NginxConfHistoryItem[]>([]);
  const loaded = ref(false);
  const loading = ref(false);
  const error = ref('');
  const keep = ref(10);
  const truncated = ref(false);
  const compare = shallowRef<NginxHistoryCompareState | null>(null);
  const downloadingName = ref('');
  let listGeneration = 0;
  let compareGeneration = 0;
  let listController: AbortController | null = null;
  let compareController: AbortController | null = null;

  /** 重置全部状态并取消进行中的请求 */
  const resetHistory = () => {
    listGeneration += 1;
    compareGeneration += 1;
    listController?.abort();
    compareController?.abort();
    listController = null;
    compareController = null;
    historyOpen.value = false;
    items.value = [];
    loaded.value = false;
    loading.value = false;
    error.value = '';
    truncated.value = false;
    compare.value = null;
    downloadingName.value = '';
  };

  /** 读取历史列表 */
  const loadHistory = async () => {
    const targetId = props.targetId;
    if (!targetId) return;
    const generation = ++listGeneration;
    listController?.abort();
    const controller = new AbortController();
    listController = controller;
    loading.value = true;
    error.value = '';
    try {
      const result = await listNginxConfHistory(targetId, controller.signal);
      if (generation !== listGeneration || props.targetId !== targetId) return;
      items.value = Array.isArray(result.items) ? result.items : [];
      keep.value = Number(result.keep) || 10;
      truncated.value = Boolean(result.truncated);
      loaded.value = true;
    } catch (err) {
      if (generation !== listGeneration || controller.signal.aborted) return;
      error.value = `读取历史版本失败：${getErrorMessage(err)}`;
    } finally {
      if (generation === listGeneration) loading.value = false;
    }
  };

  /**
   * 拉取历史版本内容与线上当前内容（并行），进入只读对比。
   * @param item 历史条目
   */
  const openCompare = async (item: NginxConfHistoryItem) => {
    const targetId = props.targetId;
    if (!targetId) return;
    const generation = ++compareGeneration;
    compareController?.abort();
    const controller = new AbortController();
    compareController = controller;
    historyOpen.value = false;
    compare.value = { item, historyContent: '', currentContent: '', currentSha256: '', currentFetchedAt: '', loading: true };
    try {
      const [history, current] = await Promise.all([
        readNginxConfHistoryItem(targetId, item.name, controller.signal),
        readNginxConf(targetId, controller.signal),
      ]);
      if (generation !== compareGeneration || props.targetId !== targetId) return;
      if (history.encodingWarning) message.warning('该历史版本不是 UTF-8 编码，部分字符可能显示为乱码');
      compare.value = {
        item,
        historyContent: history.content,
        currentContent: current.content,
        currentSha256: current.sha256 || '',
        currentFetchedAt: new Date().toISOString(),
        loading: false,
      };
    } catch (err) {
      if (generation !== compareGeneration || controller.signal.aborted) return;
      compare.value = null;
      message.error(`读取历史版本失败：${getErrorMessage(err)}`);
    }
  };

  /** 重新读取线上当前内容 */
  const refreshCurrent = async () => {
    const state = compare.value;
    if (!state) return;
    await openCompare(state.item);
  };

  /** 退出对比 */
  const exitCompare = () => {
    compareGeneration += 1;
    compareController?.abort();
    compare.value = null;
  };

  /**
   * 下载历史版本，文件名即备份文件名。
   * @param item 历史条目
   */
  const downloadItem = async (item: NginxConfHistoryItem) => {
    const targetId = props.targetId;
    if (!targetId || downloadingName.value) return;
    downloadingName.value = item.name;
    try {
      const history = await readNginxConfHistoryItem(targetId, item.name);
      if (props.targetId !== targetId) return;
      downloadTextFile(history.content, sanitizeDownloadName(item.name) || 'nginx.conf.bak');
    } catch (err) {
      message.error(`下载历史版本失败：${getErrorMessage(err)}`);
    } finally {
      downloadingName.value = '';
    }
  };

  watch(
    () => props.targetId,
    () => resetHistory()
  );

  onScopeDispose(() => resetHistory());

  return {
    historyOpen,
    items,
    loaded,
    loading,
    error,
    keep,
    truncated,
    compare,
    downloadingName,
    loadHistory,
    openCompare,
    refreshCurrent,
    exitCompare,
    downloadItem,
    resetHistory,
  };
}
