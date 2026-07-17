import { computed, onMounted, onUnmounted, ref } from 'vue';
import { message } from 'ant-design-vue';
import {
  checkAppUpdateFromServer,
  getAppUpdateCacheStatus,
  type AppUpdateCacheStatus,
  type AppUpdateCheckResult,
} from '@/api/deploy';
import { isTauri } from '@/utils/env';
import type { UpdateState } from '../constant';
import {
  AUTO_CHECK_INTERVAL_MS,
  CACHE_STATUS_MAX_ERRORS,
  CACHE_STATUS_POLL_INTERVAL_MS,
  CACHE_STATUS_TIMEOUT_MS,
  INITIAL_CHECK_DELAY_MS,
  NATIVE_TASK_RELEASE_INTERVAL_MS,
  NATIVE_TASK_RELEASE_MAX_ATTEMPTS,
  PROGRESS_POLL_INTERVAL_MS,
} from '../constant';
import {
  useNativeAppUpdate,
  type NativeAppUpdateStatus,
} from './useNativeAppUpdate';

type UpdateAssetMetadata = Pick<
  AppUpdateCheckResult,
  'assetId' | 'etag' | 'filename' | 'sha256' | 'signature' | 'size' | 'source' | 'target'
>;

const nativeAppUpdate = useNativeAppUpdate();

/** 创建无更新任务时的初始状态。 */
const createIdleUpdateState = (): UpdateState => ({
  status: 'idle',
  progress: 0,
  error: null,
  downloadedBytes: 0,
  totalBytes: null,
  bytesPerSecond: 0,
  remainingSeconds: null,
  resumable: false,
  retryCount: 0,
});

/** 是否展示已就绪更新胶囊。 */
const hasUpdate = ref(false);
/** 是否已经检测到远程新版本。 */
const detectedUpdate = ref(false);
const checkingUpdate = ref(false);
const currentAppVersion = ref('1.0.0');
const latestVersion = ref('');
const updateLogs = ref('');
const downloadUrl = ref('');
const cacheStatusUrl = ref('');
const updateAsset = ref<UpdateAssetMetadata>({});
const updateState = ref<UpdateState>(createIdleUpdateState());

const updatePercent = computed(() => updateState.value.progress);

let progressInterval: ReturnType<typeof setInterval> | null = null;
let cacheStatusInterval: ReturnType<typeof setInterval> | null = null;
let autoUpdateInterval: ReturnType<typeof setInterval> | null = null;
let initialCheckTimer: ReturnType<typeof setTimeout> | null = null;
let unlistenMenuCheckUpdate: (() => void) | null = null;
let instanceCount = 0;
let pollingCacheStatus = false;
let pollingNativeStatus = false;
let cachePollingGeneration = 0;
let progressPollingGeneration = 0;
let cachePollingStartedAt = 0;
let cachePollingErrorCount = 0;
let cachePollingManual = false;
let notifyDownloadFailure = false;

/** 等待指定时长。 */
const delay = (milliseconds: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, milliseconds);
});

/** 规范化接口和原生层使用的版本号。 */
const normalizeVersion = (version: string) => version.replace(/^v/, '');

/** 获取当前更新资源在客户端的稳定身份。 */
const getCurrentAssetIdentity = () => {
  if (updateAsset.value.assetId) return `github:${updateAsset.value.assetId}`;
  const target = updateAsset.value.target || 'unknown';
  return `manifest:${normalizeVersion(latestVersion.value)}:${target}:${updateAsset.value.filename || 'unknown'}`;
};

/** 获取接口结果对应的稳定客户端资源身份。 */
const getResultAssetIdentity = (result: AppUpdateCheckResult) => {
  if (result.assetId) return `github:${result.assetId}`;
  const version = normalizeVersion(result.latestVersion || result.version || '');
  return `manifest:${version}:${result.target || 'unknown'}:${result.filename || 'unknown'}`;
};

/** 判断原生状态是否属于当前检测到的更新资源。 */
const isCurrentNativeAsset = (status: NativeAppUpdateStatus) => {
  return Boolean(
    latestVersion.value
      && updateAsset.value.filename
      && normalizeVersion(status.version) === normalizeVersion(latestVersion.value)
      && status.assetId === getCurrentAssetIdentity()
      && status.filename === updateAsset.value.filename
      && Boolean(updateAsset.value.signature)
      && status.expectedSignature === updateAsset.value.signature
  );
};

/** 判断原生状态中是否包含可清理的历史资源。 */
const hasNativeAssetMetadata = (status: NativeAppUpdateStatus) => {
  return Boolean(status.version || status.assetId || status.filename);
};

/** 将原生下载状态同步到 Vue 响应式状态。 */
const applyNativeUpdateStatus = (status: NativeAppUpdateStatus) => {
  updateState.value = {
    status: status.status,
    progress: status.progress,
    error: status.error,
    downloadedBytes: status.downloadedBytes,
    totalBytes: status.totalBytes,
    bytesPerSecond: status.bytesPerSecond,
    remainingSeconds: status.remainingSeconds,
    resumable: status.resumable,
    retryCount: status.retryCount,
  };
  hasUpdate.value = detectedUpdate.value
    && status.status === 'completed'
    && isCurrentNativeAsset(status);
};

/** 初始化本地应用版本号。 */
const initLocalVersion = async () => {
  if (currentAppVersion.value !== '1.0.0' || !isTauri()) return;
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    currentAppVersion.value = await getVersion();
  } catch (error) {
    console.warn('[Update] 获取本地版本号失败，使用默认配置:', error);
  }
};

/** 清除原生下载进度轮询。 */
const clearProgressPolling = () => {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
  progressPollingGeneration += 1;
};

/** 清除服务器更新包缓存状态轮询。 */
const clearCacheStatusPolling = () => {
  if (cacheStatusInterval) {
    clearInterval(cacheStatusInterval);
    cacheStatusInterval = null;
  }
  cachePollingGeneration += 1;
  cachePollingStartedAt = 0;
  cachePollingErrorCount = 0;
  cachePollingManual = false;
};

/** 将服务器缓存状态映射为内部状态，自动流程仍保持胶囊隐藏。 */
const applyCacheStatus = (status: AppUpdateCacheStatus) => {
  const mappedStatus = status.status === 'ready'
    ? 'idle'
    : status.status === 'failed'
      ? 'error'
      : 'preparing';
  updateState.value = {
    status: mappedStatus,
    progress: status.status === 'ready' ? 0 : status.progress,
    error: status.error,
    downloadedBytes: status.status === 'ready' ? 0 : status.downloadedBytes,
    totalBytes: status.totalBytes,
    bytesPerSecond: status.status === 'ready' ? 0 : status.bytesPerSecond,
    remainingSeconds: status.status === 'ready' ? null : status.remainingSeconds,
    resumable: status.downloadedBytes > 0,
    retryCount: status.retryCount,
  };
  hasUpdate.value = false;
};

/** 等待并清理仍在退出中的旧原生下载任务。 */
const discardNativeUpdate = async () => {
  for (let attempt = 0; attempt < NATIVE_TASK_RELEASE_MAX_ATTEMPTS; attempt += 1) {
    const result = await nativeAppUpdate.discard();
    if (result.success) return;
    await delay(NATIVE_TASK_RELEASE_INTERVAL_MS);
  }
  throw new Error('旧版本更新任务尚未释放，请稍后重试');
};

/** 安装用户已经明确点击确认的就绪更新。 */
const installReadyUpdate = async () => {
  if (updateState.value.status !== 'completed') return;
  try {
    message.loading({
      content: `正在验证 v${latestVersion.value} 更新状态...`,
      duration: 0,
      key: 'app-update-install',
    });
    if (!await revalidateReadyUpdate()) return;
    updateState.value.status = 'installing';
    message.loading({
      content: `正在验签并安装 v${latestVersion.value}，完成后将自动重启...`,
      duration: 0,
      key: 'app-update-install',
    });
    const result = await nativeAppUpdate.install();
    if (!result.success) throw new Error(result.message || '更新安装失败');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error || '更新安装失败');
    const nativeStatus = await nativeAppUpdate.getStatus().catch(() => null);
    if (nativeStatus?.status === 'completed' && isCurrentNativeAsset(nativeStatus)) {
      applyNativeUpdateStatus(nativeStatus);
    } else {
      hasUpdate.value = false;
      updateState.value.status = 'error';
      updateState.value.error = errorMessage;
    }
    message.error({
      content: `验证、安装或重启失败：${errorMessage}`,
      key: 'app-update-install',
    });
  }
};

/**
 * 查询一次原生下载状态并处理终态。
 * @param generation 当前下载轮询代次，过期结果会被丢弃
 */
const syncNativeDownloadStatus = async (generation: number) => {
  if (generation !== progressPollingGeneration || pollingNativeStatus) return;
  pollingNativeStatus = true;
  try {
    const status = await nativeAppUpdate.getStatus();
    if (generation !== progressPollingGeneration) return;
    applyNativeUpdateStatus(status);
    if (status.status === 'completed') {
      clearProgressPolling();
      if (isCurrentNativeAsset(status)) {
        console.log(`[Update] v${latestVersion.value} 已静默下载并校验完成，等待用户安装`);
      }
      notifyDownloadFailure = false;
    } else if (status.status === 'error' || status.status === 'paused') {
      clearProgressPolling();
      hasUpdate.value = false;
      if (notifyDownloadFailure) {
        const reason = status.error || (status.status === 'paused' ? '下载已暂停' : '下载失败');
        message.error(`更新包准备失败：${reason}`);
      }
      notifyDownloadFailure = false;
    }
  } catch (error) {
    console.warn('[Update] 查询原生下载状态失败:', error);
  } finally {
    pollingNativeStatus = false;
  }
};

/** 启动原生下载状态轮询。 */
const startProgressPolling = (manual: boolean) => {
  clearProgressPolling();
  const generation = progressPollingGeneration;
  notifyDownloadFailure = notifyDownloadFailure || manual;
  void syncNativeDownloadStatus(generation);
  progressInterval = setInterval(() => {
    void syncNativeDownloadStatus(generation);
  }, PROGRESS_POLL_INTERVAL_MS);
};

/** 在服务器缓存就绪后静默下载当前更新包。 */
const triggerUpdateDownload = async (manual = false) => {
  if (!downloadUrl.value || !latestVersion.value || !updateAsset.value.filename) return;
  hasUpdate.value = false;
  try {
    updateState.value.status = 'downloading';
    updateState.value.error = null;
    const result = await nativeAppUpdate.startDownload(
      downloadUrl.value,
      updateAsset.value.filename,
      {
        version: normalizeVersion(latestVersion.value),
        assetId: getCurrentAssetIdentity(),
        expectedSize: updateAsset.value.size,
        sha256: updateAsset.value.sha256,
        etag: updateAsset.value.etag,
        signature: updateAsset.value.signature,
      }
    );
    if (!result.success) throw new Error(result.message || '启动下载失败');
    startProgressPolling(manual);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error || '启动下载失败');
    updateState.value.status = 'error';
    updateState.value.error = errorMessage;
    hasUpdate.value = false;
    console.warn('[Update] 静默下载启动失败:', error);
    if (manual) message.error(`更新包准备失败：${errorMessage}`);
  }
};

/**
 * 查询一次服务器更新包缓存状态。
 * @param generation 当前缓存轮询代次，过期结果会被丢弃
 */
const pollCacheStatus = async (generation = cachePollingGeneration) => {
  if (
    generation !== cachePollingGeneration
    || !cacheStatusUrl.value
    || pollingCacheStatus
  ) return;
  if (
    cachePollingStartedAt > 0
    && Date.now() - cachePollingStartedAt >= CACHE_STATUS_TIMEOUT_MS
  ) {
    const shouldNotify = cachePollingManual;
    clearCacheStatusPolling();
    updateState.value.status = 'error';
    updateState.value.error = '服务器准备更新包超时';
    if (shouldNotify) message.warning('更新包准备时间较长，后台稍后会自动重试');
    return;
  }

  pollingCacheStatus = true;
  try {
    const status = await getAppUpdateCacheStatus(cacheStatusUrl.value);
    if (generation !== cachePollingGeneration) return;
    cachePollingErrorCount = 0;
    if (status.statusUrl) cacheStatusUrl.value = status.statusUrl;
    if (status.downloadUrl) downloadUrl.value = status.downloadUrl;
    if (status.etag) updateAsset.value.etag = status.etag;
    applyCacheStatus(status);

    if (status.status === 'ready') {
      const shouldNotify = cachePollingManual;
      clearCacheStatusPolling();
      await triggerUpdateDownload(shouldNotify);
    } else if (status.status === 'failed') {
      const shouldNotify = cachePollingManual;
      clearCacheStatusPolling();
      if (shouldNotify) {
        message.error(`服务器准备更新包失败：${status.error || '稍后将自动重试'}`);
      }
    } else if (status.status === 'missing') {
      const shouldNotify = cachePollingManual;
      clearCacheStatusPolling();
      void checkAppUpdate(shouldNotify);
    }
  } catch (error) {
    if (generation !== cachePollingGeneration) return;
    cachePollingErrorCount += 1;
    console.warn('[Update] 查询服务器更新包缓存状态失败:', error);
    if (cachePollingErrorCount >= CACHE_STATUS_MAX_ERRORS) {
      const shouldNotify = cachePollingManual;
      clearCacheStatusPolling();
      updateState.value.status = 'error';
      updateState.value.error = '连接更新服务器失败';
      if (shouldNotify) message.error('连接更新服务器失败，请稍后重试');
    }
  } finally {
    pollingCacheStatus = false;
  }
};

/** 启动服务器缓存状态轮询。 */
const startCacheStatusPolling = (manual: boolean) => {
  clearCacheStatusPolling();
  const generation = cachePollingGeneration;
  cachePollingStartedAt = Date.now();
  cachePollingManual = manual;
  void pollCacheStatus(generation);
  cacheStatusInterval = setInterval(() => {
    void pollCacheStatus(generation);
  }, CACHE_STATUS_POLL_INTERVAL_MS);
};

/** 将远程更新信息写入当前单例状态。 */
const applyUpdateResult = (result: AppUpdateCheckResult) => {
  detectedUpdate.value = true;
  hasUpdate.value = false;
  latestVersion.value = normalizeVersion(result.latestVersion || result.version || '');
  updateLogs.value = result.updateLogs || result.notes || '无更新内容描述。';
  downloadUrl.value = result.downloadUrl || '';
  cacheStatusUrl.value = result.cache?.statusUrl || '';
  updateAsset.value = {
    assetId: result.assetId,
    etag: result.etag || result.cache?.etag,
    filename: result.filename,
    sha256: result.sha256,
    signature: result.signature,
    size: result.size,
    source: result.source,
    target: result.target,
  };
};

/** 接管当前原生状态，并在服务器缓存就绪后开始静默预下载。 */
const reconcileUpdate = async (result: AppUpdateCheckResult, manual: boolean) => {
  let nativeStatus = await nativeAppUpdate.getStatus();
  if (hasNativeAssetMetadata(nativeStatus) && !isCurrentNativeAsset(nativeStatus)) {
    await discardNativeUpdate();
    nativeStatus = await nativeAppUpdate.getStatus();
  }

  if (isCurrentNativeAsset(nativeStatus) && nativeStatus.status === 'completed') {
    applyNativeUpdateStatus(nativeStatus);
    if (manual) message.success(`新版本 v${latestVersion.value} 已准备完成，请点击顶部胶囊安装`);
    return;
  }
  if (isCurrentNativeAsset(nativeStatus) && nativeStatus.status === 'downloading') {
    applyNativeUpdateStatus(nativeStatus);
    startProgressPolling(manual);
    if (manual) message.info(`新版本 v${latestVersion.value} 正在后台准备，完成后会显示安装按钮`);
    return;
  }

  const cache = result.cache;
  if (!cache || cache.status === 'ready') {
    if (manual) message.info(`发现新版本 v${latestVersion.value}，正在后台准备安装包`);
    await triggerUpdateDownload(manual);
    return;
  }

  applyCacheStatus(cache);
  if (cache.status === 'failed') {
    if (manual) message.error(`服务器准备更新包失败：${cache.error || '稍后将自动重试'}`);
    return;
  }
  if (manual) message.info(`发现新版本 v${latestVersion.value}，服务器正在准备更新包`);
  startCacheStatusPolling(manual);
};

/** 安装前重新确认版本仍有效，并在出现更高版本时切换静默准备目标。 */
async function revalidateReadyUpdate(): Promise<boolean> {
  const target = await nativeAppUpdate.getTarget();
  const result = await checkAppUpdateFromServer(
    currentAppVersion.value,
    target.platform,
    target.arch
  );
  if (!result?.hasUpdate || !result.downloadUrl) {
    await discardNativeUpdate();
    detectedUpdate.value = false;
    hasUpdate.value = false;
    updateState.value = createIdleUpdateState();
    message.warning({
      content: '该更新版本已撤回或不再适用，已清理本机安装包',
      key: 'app-update-install',
    });
    return false;
  }
  if (!result.signature) {
    message.error({
      content: '服务器未返回签名 Updater 资源，已保留本机已验证更新包并取消安装',
      key: 'app-update-install',
    });
    return false;
  }

  const resultVersion = normalizeVersion(result.latestVersion || result.version || '');
  const sameAsset = resultVersion === normalizeVersion(latestVersion.value)
    && result.filename === updateAsset.value.filename
    && getResultAssetIdentity(result) === getCurrentAssetIdentity()
    && Boolean(result.signature)
    && result.signature === updateAsset.value.signature;
  if (sameAsset) return true;

  applyUpdateResult(result);
  await reconcileUpdate(result, false);
  message.info({
    content: `检测到更新版本 v${latestVersion.value}，正在重新准备安装包`,
    key: 'app-update-install',
  });
  return false;
}

/** 执行更新检测，并区分自动静默与手动反馈。 */
const checkAppUpdate = async (manual = false) => {
  if (checkingUpdate.value) {
    if (manual) message.info('正在检查更新，请稍候');
    return;
  }
  checkingUpdate.value = true;
  const hideLoading = manual ? message.loading('正在检查更新...', 0) : null;

  try {
    await initLocalVersion();
    const target = await nativeAppUpdate.getTarget();
    const result = await checkAppUpdateFromServer(
      currentAppVersion.value,
      target.platform,
      target.arch
    );

    if (result?.hasUpdate && result.downloadUrl) {
      if (!result.signature) {
        throw new Error('服务器未返回签名 Updater 资源，已阻止手工安装包回退');
      }
      clearCacheStatusPolling();
      applyUpdateResult(result);
      await reconcileUpdate(result, manual);
      return;
    }

    detectedUpdate.value = false;
    hasUpdate.value = false;
    clearCacheStatusPolling();
    clearProgressPolling();
    const nativeStatus = await nativeAppUpdate.getStatus();
    if (hasNativeAssetMetadata(nativeStatus)) await discardNativeUpdate();
    updateState.value = createIdleUpdateState();
    if (manual) message.success(result?.message || '当前已是最新版本！');
  } catch (error: any) {
    console.warn('[Update] 更新检测或静默准备失败:', error);
    hasUpdate.value = false;
    if (manual) {
      const errorMessage = error.response?.data?.error || error.message || '连接内网服务器异常';
      message.error(`检查更新失败：${errorMessage}`);
    }
  } finally {
    hideLoading?.();
    checkingUpdate.value = false;
  }
};

/** 处理用户点击已就绪胶囊。 */
const handleCapsuleClick = () => {
  if (updateState.value.status === 'completed') {
    void installReadyUpdate();
  } else if (updateState.value.status === 'installing') {
    message.info('正在安装更新并准备重启，请稍候');
  }
};

/** 处理系统菜单或页面菜单中的“检查更新”。 */
const handleCheckUpdateClick = () => {
  if (hasUpdate.value && updateState.value.status === 'completed') {
    message.success(`新版本 v${latestVersion.value} 已准备完成，请点击顶部胶囊安装`);
    return;
  }
  if (detectedUpdate.value && updateState.value.status === 'downloading') {
    message.info(`新版本 v${latestVersion.value} 正在后台准备，完成后会显示安装按钮`);
    return;
  }
  if (detectedUpdate.value && updateState.value.status === 'preparing') {
    cachePollingManual = true;
    message.info(`新版本 v${latestVersion.value} 的安装包正在服务器准备中`);
    void pollCacheStatus(cachePollingGeneration);
    return;
  }
  if (updateState.value.status === 'installing') {
    message.info('正在安装更新并准备重启，请稍候');
    return;
  }
  void checkAppUpdate(true);
};

/**
 * 自动更新单例 Composable。
 * @description 自动检测、服务端预热和本机预下载保持静默，仅在安装包完整校验后展示胶囊。
 */
export const useAppUpdate = () => {
  onMounted(() => {
    instanceCount += 1;
    if (instanceCount !== 1 || !isTauri()) return;

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('menu-check-update', handleCheckUpdateClick).then((unlisten) => {
        unlistenMenuCheckUpdate = unlisten;
      });
    });

    initialCheckTimer = setTimeout(() => {
      initialCheckTimer = null;
      void checkAppUpdate(false);
    }, INITIAL_CHECK_DELAY_MS);

    autoUpdateInterval = setInterval(() => {
      void checkAppUpdate(false);
    }, AUTO_CHECK_INTERVAL_MS);
  });

  onUnmounted(() => {
    instanceCount -= 1;
    if (instanceCount > 0) return;
    instanceCount = 0;
    clearProgressPolling();
    clearCacheStatusPolling();
    if (initialCheckTimer) {
      clearTimeout(initialCheckTimer);
      initialCheckTimer = null;
    }
    if (autoUpdateInterval) {
      clearInterval(autoUpdateInterval);
      autoUpdateInterval = null;
    }
    unlistenMenuCheckUpdate?.();
    unlistenMenuCheckUpdate = null;
  });

  return {
    /** 是否展示已就绪更新胶囊 */
    hasUpdate,
    /** 当前更新状态 */
    updateState,
    /** 当前进度百分比 */
    updatePercent,
    /** 最新版本号 */
    latestVersion,
    /** 更新日志 */
    updateLogs,
    /** 是否正在检查更新 */
    checkingUpdate,
    /** 手动或自动检查更新 */
    checkAppUpdate,
    /** 点击已就绪胶囊 */
    handleCapsuleClick,
    /** 菜单检查更新 */
    handleCheckUpdateClick,
  };
};
