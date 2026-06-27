import { ref, computed, onMounted, onUnmounted } from 'vue';
import { isTauri } from '@/utils/env';
import { checkAppUpdateFromServer, type AppUpdateCheckResult } from '@/api/deploy';
import { message } from 'ant-design-vue';
import type { UpdateState } from '../constant';
import { useNativeAppUpdate } from './useNativeAppUpdate';
import {
  PROGRESS_POLL_INTERVAL_MS,
  CLOSE_APP_DELAY_MS,
  AUTO_CHECK_INTERVAL_MS,
  INITIAL_CHECK_DELAY_MS,
} from '../constant';

const nativeAppUpdate = useNativeAppUpdate();

// ============ 单例模式：全局共享状态 ============
const hasUpdate = ref(false);
const checkingUpdate = ref(false);
const currentAppVersion = ref('1.0.0');
const latestVersion = ref('');
const updateLogs = ref('');
const downloadUrl = ref('');
const updateAsset = ref<Pick<AppUpdateCheckResult, 'filename' | 'size' | 'sha256' | 'etag'>>({});

const updateState = ref<UpdateState>({
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

const updatePercent = computed(() => updateState.value.progress);

let progressInterval: ReturnType<typeof setInterval> | null = null;
let autoUpdateInterval: ReturnType<typeof setInterval> | null = null;
let unlistenMenuCheckUpdate: (() => void) | null = null;
let instanceCount = 0;

/** 将原生下载状态同步到 Vue 响应式状态。 */
const applyNativeUpdateStatus = (status: Awaited<ReturnType<typeof nativeAppUpdate.getStatus>>) => {
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
};

/**
 * 初始化本地应用版本号
 */
const initLocalVersion = async () => {
  if (currentAppVersion.value !== '1.0.0') return;
  if (isTauri()) {
    try {
      const { getVersion } = await import('@tauri-apps/api/app');
      currentAppVersion.value = await getVersion();
    } catch (e) {
      console.warn('获取本地版本号失败，使用默认配置:', e);
    }
  }
};

/**
 * 语义化版本号对比：判断 remote 是否比 local 新
 * @param local 当前本地版本号
 * @param remote 远程最新版本号
 */
const isNewerVersion = (local: string, remote: string): boolean => {
  const l = local.replace(/^v/, '');
  const r = remote.replace(/^v/, '');
  if (l === r) return false;

  const [lMain, lPre] = l.split('-');
  const [rMain, rPre] = r.split('-');
  const lParts = lMain.split('.').map(Number);
  const rParts = rMain.split('.').map(Number);

  for (let i = 0; i < Math.max(lParts.length, rParts.length); i++) {
    const lNum = lParts[i] || 0;
    const rNum = rParts[i] || 0;
    if (rNum > lNum) return true;
    if (lNum > rNum) return false;
  }

  if (rPre && !lPre) return false;
  if (!rPre && lPre) return true;
  if (rPre && lPre && rPre !== lPre) return true;
  return false;
};

/**
 * 清除进度轮询定时器
 */
const clearProgressPolling = () => {
  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }
};

/**
 * 下载完成后自动拉起安装程序并关闭 APP
 */
const autoInstallAndClose = async () => {
  try {
    updateState.value.status = 'installing';
    message.loading({ content: '⚡ 正在为您拉起安装程序...', duration: 5, key: 'auto-install' });

    const res = await nativeAppUpdate.install();
    if (!res?.success) {
      throw new Error(res?.message || '拉起安装失败');
    }

    message.success({ content: '安装程序已启动，应用即将关闭以完成覆盖升级...', key: 'auto-install', duration: 3 });

    // 延迟关闭 APP，释放文件占用以顺利覆盖安装
    setTimeout(async () => {
      try {
        if (isTauri()) {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('exit_app');
        }
      } catch (closeErr) {
        console.warn('[Update] 自动关闭窗口并退出应用失败:', closeErr);
      }
    }, CLOSE_APP_DELAY_MS);
  } catch (e: any) {
    console.error('[Update] 自动安装失败:', e);
    updateState.value.status = 'completed';
    message.error({ content: `自动安装失败: ${e.message || e}，请手动点击安装`, key: 'auto-install' });
  }
};

/**
 * 启动后台进度轮询
 */
const startProgressPolling = () => {
  clearProgressPolling();
  progressInterval = setInterval(async () => {
    try {
      const res = await nativeAppUpdate.getStatus();
      applyNativeUpdateStatus(res);

      if (res.status === 'completed') {
        console.log('[Update] 后台下载完成！自动拉起安装...');
        clearProgressPolling();
        // 下载完成后立即自动安装
        void autoInstallAndClose();
      } else if (res.status === 'error') {
        console.error('[Update] 下载过程中发生错误:', res.error);
        clearProgressPolling();
      } else if (res.status === 'paused') {
        clearProgressPolling();
      }
    } catch (e) {
      console.error('[Update] 轮询下载进度失败:', e);
    }
  }, PROGRESS_POLL_INTERVAL_MS);
};

/**
 * 用户确认后发起后台更新包下载
 */
const triggerUpdateDownload = async () => {
  if (!downloadUrl.value) return;
  const target = await nativeAppUpdate.getTarget();
  const filename =
    updateAsset.value.filename ||
    `yuyan-${latestVersion.value}.${target.platform === 'macos' ? 'dmg' : 'exe'}`;

  try {
    updateState.value.status = 'downloading';
    updateState.value.error = null;
    const res = await nativeAppUpdate.startDownload(downloadUrl.value, filename, {
      expectedSize: updateAsset.value.size,
      sha256: updateAsset.value.sha256,
      etag: updateAsset.value.etag,
    });
    if (res?.success) {
      startProgressPolling();
    } else {
      throw new Error(res?.message || '启动下载失败');
    }
  } catch (e: any) {
    const errorMsg = e instanceof Error ? e.message : String(e || '启动原生更新下载失败');
    updateState.value.status = 'error';
    updateState.value.error = errorMsg;
    console.error('[Update] 启动 Tauri 原生下载失败:', e);
  }
};

/**
 * 执行 GitHub Releases 更新检测
 * @param manual 是否为手动触发
 */
const checkAppUpdate = async (manual = false) => {
  if (checkingUpdate.value) return;
  checkingUpdate.value = true;

  try {
    await initLocalVersion();
    const target = await nativeAppUpdate.getTarget();
    const res = await checkAppUpdateFromServer(currentAppVersion.value, target.platform, target.arch);

    if (res?.hasUpdate && res.downloadUrl) {
      hasUpdate.value = true;
      latestVersion.value = res.latestVersion || '';
      updateLogs.value = res.updateLogs || '无更新内容描述。';
      downloadUrl.value = res.downloadUrl;
      updateAsset.value = {
        filename: res.filename,
        size: res.size,
        sha256: res.sha256,
        etag: res.etag,
      };

      // 检测并接管当前 Tauri 原生下载状态
      try {
        const statusRes = await nativeAppUpdate.getStatus();
        applyNativeUpdateStatus(statusRes);

        if (statusRes.status === 'downloading') {
          startProgressPolling();
        } else if (statusRes.status === 'idle') {
          console.log('[Update] 检测到有新版本，等待用户手动点击更新按钮');
        } else if (statusRes.status === 'completed') {
          console.log('[Update] 更新包已下载完成，等待用户手动点击安装');
        }
      } catch (nativeError) {
        console.warn('获取 Tauri 原生下载状态失败:', nativeError);
        updateState.value.status = 'error';
        updateState.value.error =
          nativeError instanceof Error ? nativeError.message : String(nativeError);
      }
    } else {
      hasUpdate.value = false;
      if (manual) {
        message.success(res?.message || '当前已是最新版本！');
      }
    }
  } catch (error: any) {
    console.error('内网代理更新检测失败:', error);
    if (manual) {
      const errMsg = error.response?.data?.error || error.message || '连接内网服务器异常';
      message.error(`检查更新失败: ${errMsg}`);
    }
  } finally {
    checkingUpdate.value = false;
  }
};

/**
 * 胶囊点击事件处理器
 */
const handleCapsuleClick = async () => {
  if (updateState.value.status === 'idle' || updateState.value.status === 'paused') {
    // 用户主动点击"更新"按钮后才开始后台下载
    void triggerUpdateDownload();
  } else if (updateState.value.status === 'completed') {
    void autoInstallAndClose();
  } else if (updateState.value.status === 'error') {
    void triggerUpdateDownload();
  }
};

/** 暂停当前下载并保留断点文件。 */
const pauseUpdateDownload = async () => {
  if (updateState.value.status !== 'downloading') return;
  await nativeAppUpdate.cancelDownload();
};

/**
 * 菜单"检查更新"按钮点击
 */
const handleCheckUpdateClick = () => {
  if (hasUpdate.value && updateState.value.status === 'completed') {
    void autoInstallAndClose();
    return;
  }
  if (hasUpdate.value && updateState.value.status === 'downloading') {
    message.info('新版本正在后台加速下载中，请稍后...');
    return;
  }
  if (hasUpdate.value && updateState.value.status === 'installing') {
    message.info('安装程序已拉起，请等待覆盖升级完成...');
    return;
  }
  void checkAppUpdate(true);
};

// ============ 单例生命周期管理 ============

/**
 * 自动更新单例 Composable
 * @description 全局唯一实例，确保 Layout 菜单与胶囊组件共享同一份更新状态。
 * 首次挂载时自动启动后台检测，最后一个消费者卸载时清理定时器。
 */
export const useAppUpdate = () => {
  onMounted(() => {
    instanceCount++;
    // 只在首次挂载时启动生命周期
    if (instanceCount === 1 && isTauri()) {
      // 监听 macOS 顶部系统菜单"检查更新"事件
      import('@tauri-apps/api/event').then(({ listen }) => {
        listen('menu-check-update', () => {
          handleCheckUpdateClick();
        }).then((unlisten) => {
          unlistenMenuCheckUpdate = unlisten;
        });
      });

      // 延迟 2 秒后启动首次静默检测
      setTimeout(() => {
        void checkAppUpdate(false);
      }, INITIAL_CHECK_DELAY_MS);

      // 每 15 分钟后台静默检测一次新版本
      autoUpdateInterval = setInterval(() => {
        void checkAppUpdate(false);
      }, AUTO_CHECK_INTERVAL_MS);
    }
  });

  onUnmounted(() => {
    instanceCount--;
    if (instanceCount <= 0) {
      instanceCount = 0;
      clearProgressPolling();
      if (autoUpdateInterval) {
        clearInterval(autoUpdateInterval);
        autoUpdateInterval = null;
      }
      if (unlistenMenuCheckUpdate) {
        unlistenMenuCheckUpdate();
        unlistenMenuCheckUpdate = null;
      }
    }
  });

  return {
    /** 是否发现新版本 */
    hasUpdate,
    /** 更新状态详情 */
    updateState,
    /** 下载百分比 */
    updatePercent,
    /** 最新版本号 */
    latestVersion,
    /** 更新日志 */
    updateLogs,
    /** 是否正在检测中 */
    checkingUpdate,
    /** 手动检查更新 */
    checkAppUpdate,
    /** 胶囊点击事件 */
    handleCapsuleClick,
    /** 暂停更新下载 */
    pauseUpdateDownload,
    /** 菜单"检查更新"点击 */
    handleCheckUpdateClick,
  };
};
