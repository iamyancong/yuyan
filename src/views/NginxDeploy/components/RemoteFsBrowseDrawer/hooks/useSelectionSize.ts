import { computed, ref, watch, type Ref } from 'vue';
import { getServerFsSize, type RemoteFsEntry } from '@/api/deploy';
import { formatArchiveBytes } from '@/views/NginxDeploy/hooks/useNginxArchiveDownload';

/** 选区体积查询状态。 */
export type SelectionSizeStatus = 'idle' | 'loading' | 'done' | 'error';

/**
 * 远程文件浏览器多选体积估算 Hook。
 * 负责在多选文件/目录时异步计算预计下载体积（排除隐藏文件，支持 300ms 防抖、选区变更即时中断、请求版本校验、纯文件快速路径与按路径缓存）。
 *
 * @param serverIdRef 服务器 ID 引用
 * @param selectedEntriesRef 选中的条目列表引用
 * @param currentPathRef 当前浏览路径引用（切换目录时自动清空缓存）
 */
export function useSelectionSize(
  serverIdRef: Ref<number | undefined>,
  selectedEntriesRef: Ref<RemoteFsEntry[]>,
  currentPathRef: Ref<string>
) {
  /** 排除隐藏文件后的预估总字节数（压缩前）。 */
  const estimatedBytes = ref(0);
  /** 当前查询状态。 */
  const sizeStatus = ref<SelectionSizeStatus>('idle');
  /** 错误或超时说明信息。 */
  const sizeError = ref('');
  /** 部分文件不可读等非阻断性警告。 */
  const sizeWarning = ref('');
  /** 是否因超时而截断。 */
  const sizeTruncated = ref(false);

  /** 按 `serverId:path` 粒度缓存已计算的目录大小。 */
  const sizeCache = new Map<string, number>();

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let activeAbortController: AbortController | null = null;
  let latestRequestId = 0;

  /** 清空大小查询缓存。 */
  const clearSizeCache = () => {
    sizeCache.clear();
  };

  /** 计算纯文件条目列表的大小总和（直接使用已有 size 字段）。 */
  const sumFileSizes = (entries: RemoteFsEntry[]): number => {
    return entries.reduce((acc, cur) => acc + (cur.size ?? 0), 0);
  };

  /** 判断选中列表中是否存在目录。 */
  const hasDirectory = (entries: RemoteFsEntry[]): boolean => {
    return entries.some((e) => e.type === 'directory');
  };

  /** 格式化后的体积文案（如 '约 210 MB'）。只在计算完成且有大小时返回，计算过程中绝不返回 '约 0 B'。 */
  const formattedSize = computed(() => {
    if (sizeStatus.value !== 'done' || estimatedBytes.value <= 0) return '';
    return `约 ${formatArchiveBytes(estimatedBytes.value)}`;
  });

  /** 右键菜单专用的体积说明文案：计算中显示 '计算中…'，计算完成显示 '约 210 MB'，其他不显示。 */
  const contextMenuSizeLabel = computed(() => {
    if (sizeStatus.value === 'loading') return '计算中…';
    if (sizeStatus.value === 'done' && estimatedBytes.value > 0) {
      return `约 ${formatArchiveBytes(estimatedBytes.value)}`;
    }
    return '';
  });

  /** 是否超过 500MB 大包预警阈值。 */
  const isLargePackage = computed(() => {
    return estimatedBytes.value > 500 * 1024 * 1024;
  });

  /** 执行实际的体积计算（包含请求版本号校验）。 */
  const performCalculate = async (entries: RemoteFsEntry[], serverId: number, requestId: number) => {
    if (!entries || entries.length === 0) {
      if (requestId !== latestRequestId) return;
      sizeStatus.value = 'idle';
      estimatedBytes.value = 0;
      sizeTruncated.value = false;
      sizeError.value = '';
      sizeWarning.value = '';
      return;
    }

    // 纯文件快速路径：无需发请求，直接相加列表中已有的 size
    if (!hasDirectory(entries)) {
      if (requestId !== latestRequestId) return;
      estimatedBytes.value = sumFileSizes(entries);
      sizeStatus.value = 'done';
      sizeTruncated.value = false;
      sizeError.value = '';
      sizeWarning.value = '';
      return;
    }

    // 包含目录：先从缓存中提取
    const uncachedPaths: string[] = [];
    let cachedTotal = 0;

    for (const entry of entries) {
      const cacheKey = `${serverId}:${entry.path}`;
      if (sizeCache.has(cacheKey)) {
        cachedTotal += sizeCache.get(cacheKey) || 0;
      } else {
        uncachedPaths.push(entry.path);
      }
    }

    // 若全部命中缓存，直接使用缓存结果
    if (uncachedPaths.length === 0) {
      if (requestId !== latestRequestId) return;
      estimatedBytes.value = cachedTotal;
      sizeStatus.value = 'done';
      sizeTruncated.value = false;
      sizeError.value = '';
      sizeWarning.value = '';
      return;
    }

    // 发起远程 du 大小查询
    activeAbortController = new AbortController();

    try {
      const res = await getServerFsSize(serverId, uncachedPaths, activeAbortController.signal);

      // 请求已失效则丢弃
      if (requestId !== latestRequestId) return;

      // 仅当完整无误统计（无截断且无部分文件读取警告）时才写入缓存，防止偏小的值污染后续选区
      if (!res.truncated && !res.warning) {
        for (const item of res.items) {
          sizeCache.set(`${serverId}:${item.path}`, item.bytes);
        }
      }

      if (res.truncated) {
        sizeTruncated.value = true;
        sizeStatus.value = 'error';
        sizeError.value = res.warning || '部分路径查询超时，大小未知';
        sizeWarning.value = '';
        estimatedBytes.value = 0;
      } else {
        estimatedBytes.value = cachedTotal + res.totalBytes;
        sizeTruncated.value = false;
        sizeStatus.value = 'done';
        sizeError.value = '';
        sizeWarning.value = res.warning || '';
      }
    } catch (error: unknown) {
      if (requestId !== latestRequestId) return;
      // 若为主动取消，静默忽略
      if ((error as Error)?.name === 'CanceledError' || (error as Error)?.name === 'AbortError') {
        return;
      }
      sizeStatus.value = 'error';
      sizeTruncated.value = false;
      sizeError.value = (error as Error)?.message || '大小查询失败';
      sizeWarning.value = '';
      estimatedBytes.value = 0;
    }
  };

  // 监听选中项变化
  watch(
    () => {
      const serverId = serverIdRef.value;
      const pathSignature = selectedEntriesRef.value.map((e) => e.path).join('|');
      return `${serverId}:${pathSignature}`;
    },
    () => {
      // 关键修复 1：选区一变立即 abort 上一个正在飞的网络请求，防止慢响应覆盖新状态
      if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
      }
      // 关键修复 2：自增递增版本号，后续晚返回的响应直接丢弃
      const requestId = ++latestRequestId;

      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }

      const serverId = serverIdRef.value;
      const currentList = [...selectedEntriesRef.value];

      if (!serverId || currentList.length === 0) {
        sizeStatus.value = 'idle';
        estimatedBytes.value = 0;
        sizeTruncated.value = false;
        sizeError.value = '';
        sizeWarning.value = '';
        return;
      }

      // 若为纯文件立即同步计算，避免防抖延迟
      if (!hasDirectory(currentList)) {
        sizeStatus.value = 'loading';
        performCalculate(currentList, serverId, requestId);
        return;
      }

      // 含目录时立即置为 loading，防抖 300ms 后发起网络请求
      sizeStatus.value = 'loading';
      debounceTimer = setTimeout(() => {
        performCalculate(currentList, serverId, requestId);
      }, 300);
    }
  );

  // 切换浏览路径时清空缓存与当前统计状态
  watch(currentPathRef, () => {
    clearSizeCache();
    latestRequestId++;
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    sizeStatus.value = 'idle';
    estimatedBytes.value = 0;
    sizeTruncated.value = false;
    sizeError.value = '';
    sizeWarning.value = '';
  });

  return {
    estimatedBytes,
    sizeStatus,
    sizeError,
    sizeWarning,
    sizeTruncated,
    formattedSize,
    contextMenuSizeLabel,
    isLargePackage,
    clearSizeCache,
  };
}
