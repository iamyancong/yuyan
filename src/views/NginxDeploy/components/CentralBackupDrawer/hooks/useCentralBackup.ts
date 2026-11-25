import { computed, reactive, ref, watch } from 'vue';
import message from 'ant-design-vue/es/message';
import { copyToClipboard } from '@yss-ui/utils';
import {
  getCentralBackupStatus,
  runCentralBackup,
  runNginxConfigPatrol,
  updateCentralBackupSettings,
  type CentralBackupStatus,
} from '@/api/deploy';
import {
  DEFAULT_BACKUP_REMOTE_DIR,
  resolveCentralBackupPermissions,
  validateBackupRemoteDirClient,
} from '../centralBackupPolicy';

/**
 * 中央灾备抽屉状态与操作 Hook。
 * @param props 抽屉属性（open、userRole）
 */
export function useCentralBackup(props: { open: boolean; userRole?: string }) {
  const loading = ref(false);
  const saving = ref(false);
  const runningBackup = ref(false);
  const runningPatrol = ref(false);
  const copiedSha = ref(false);
  const status = ref<CentralBackupStatus | null>(null);

  const form = reactive<{
    serverId: number | null;
    remoteDir: string;
    enabled: boolean;
  }>({
    serverId: null,
    remoteDir: DEFAULT_BACKUP_REMOTE_DIR,
    enabled: false,
  });

  const permissions = computed(() => resolveCentralBackupPermissions(props.userRole));
  const dirValidation = computed(() => validateBackupRemoteDirClient(form.remoteDir));

  const syncFormFromStatus = (data: CentralBackupStatus) => {
    form.serverId = data.settings.serverId;
    form.remoteDir = data.settings.remoteDir || DEFAULT_BACKUP_REMOTE_DIR;
    form.enabled = Boolean(data.settings.enabled);
  };

  /** 拉取中央灾备最新状态 */
  const loadStatus = async () => {
    loading.value = true;
    try {
      const data = await getCentralBackupStatus();
      status.value = data;
      syncFormFromStatus(data);
    } catch (error: any) {
      message.error(error?.response?.data?.error || error?.message || '获取中央灾备状态失败');
    } finally {
      loading.value = false;
    }
  };

  /** 保存中央备份配置（仅 admin） */
  const handleSaveSettings = async () => {
    if (!permissions.value.canEditSettings) return;
    if (!dirValidation.value.valid) {
      message.warning(dirValidation.value.error);
      return;
    }
    if (form.enabled && !form.serverId) {
      message.warning('启用定时备份前请先选择备份服务器');
      return;
    }
    saving.value = true;
    try {
      const updated = await updateCentralBackupSettings({
        serverId: form.serverId,
        remoteDir: dirValidation.value.normalized,
        enabled: form.enabled,
      });
      status.value = updated;
      syncFormFromStatus(updated);
      message.success('中央备份配置已保存');
    } catch (error: any) {
      message.error(error?.response?.data?.error || error?.message || '保存中央备份配置失败');
    } finally {
      saving.value = false;
    }
  };

  /** 手动触发一次中央库异地备份 */
  const handleRunBackup = async () => {
    if (!permissions.value.canTriggerBackup || runningBackup.value) return;
    runningBackup.value = true;
    try {
      const res = await runCentralBackup();
      message.success(`中央库备份成功：${res.fileName}`);
      if (res.warnings?.length) {
        message.warning(res.warnings[0]);
      }
    } catch (error: any) {
      const errMsg = error?.response?.data?.error || error?.message || '触发中央库备份失败';
      message.error(errMsg);
    } finally {
      runningBackup.value = false;
      await loadStatus();
    }
  };

  /** 手动触发一次 Nginx 配置巡检 */
  const handleRunPatrol = async () => {
    if (!permissions.value.canTriggerPatrol || runningPatrol.value) return;
    runningPatrol.value = true;
    try {
      const summary = await runNginxConfigPatrol();
      message.success(`配置巡检完成：检查 ${summary.filesChecked} 份文件，更新 ${summary.filesUpdated} 份快照`);
    } catch (error: any) {
      message.error(error?.response?.data?.error || error?.message || 'Nginx 配置巡检失败');
    } finally {
      runningPatrol.value = false;
      await loadStatus();
    }
  };

  /** 复制完整 SHA-256 摘要 */
  const handleCopySha = async () => {
    const sha = status.value?.last?.sha256;
    if (!sha) return;
    const ok = await copyToClipboard(sha);
    if (ok) {
      copiedSha.value = true;
      message.success('SHA-256 已复制到剪贴板');
      setTimeout(() => {
        copiedSha.value = false;
      }, 1500);
    }
  };

  watch(
    () => props.open,
    (isOpen) => {
      if (isOpen) {
        void loadStatus();
      }
    },
    { immediate: true }
  );

  return {
    loading,
    saving,
    runningBackup,
    runningPatrol,
    copiedSha,
    status,
    form,
    permissions,
    dirValidation,
    loadStatus,
    handleSaveSettings,
    handleRunBackup,
    handleRunPatrol,
    handleCopySha,
  };
}
