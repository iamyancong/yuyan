<script setup lang="ts">
import { computed } from 'vue';
import {
  CheckOutlined,
  CloudUploadOutlined,
  CopyOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ScanOutlined,
} from '@ant-design/icons-vue';
import { YButton } from '@yss-ui/components/lite';
import type { DeployServer } from '@/api/deploy';
import {
  classifyCertExpiry,
  formatBackupDateTime,
  formatBackupRunContext,
  formatBackupSize,
  formatDuration,
  resolveBackupStatusTag,
  truncateSha256,
} from './centralBackupPolicy';
import { CENTRAL_BACKUP_SECRET_WARNING } from './constant';
import { useCentralBackup } from './hooks/useCentralBackup';

defineOptions({ name: 'CentralBackupDrawer' });

interface Props {
  open: boolean;
  servers: DeployServer[];
  userRole?: string;
}

const props = withDefaults(defineProps<Props>(), {
  servers: () => [],
  userRole: '',
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
}>();

const visible = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
});

const {
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
} = useCentralBackup(props);

const backupStatusTag = computed(() =>
  resolveBackupStatusTag(status.value?.last?.status, Boolean(runningBackup.value || status.value?.running))
);

const backupRunContext = computed(() =>
  formatBackupRunContext(status.value?.last?.trigger, status.value?.last?.operator)
);

const hasLastDuration = computed(() => {
  const s = status.value?.last?.status;
  return (s === 'success' || s === 'failed') && Number.isFinite(status.value?.last?.durationMs);
});

const serverLabel = computed(() => {
  const s = status.value?.settings;
  if (!s?.serverId) return '未配置';
  const hostPart = s.serverHost ? `${s.serverHost}:${s.serverPort || 22}` : '';
  return hostPart ? `${s.serverName || `服务器 #${s.serverId}`} (${hostPart})` : s.serverName || `服务器 #${s.serverId}`;
});

const serverOptions = computed(() =>
  props.servers.map((srv) => ({
    value: srv.id,
    label: `${srv.name} (${srv.host}:${srv.port || 22})`,
  }))
);

const patrolCertRows = computed(() => {
  const list = status.value?.patrol?.certs || [];
  const now = Date.now();
  return list.map((item) => ({
    ...item,
    expiry: classifyCertExpiry(item.notAfter, now),
    notAfterDisplay: item.notAfter ? formatBackupDateTime(item.notAfter) : '未获取到到期时间',
  }));
});
</script>

<template>
  <a-drawer
    v-model:open="visible"
    title="中央数据灾备"
    width="min(780px, 92vw)"
    class="central-backup-drawer"
    :destroy-on-close="false"
  >
    <template #extra>
      <a-space>
        <YButton size="small" :loading="loading" @click="loadStatus">
          <template #icon><ReloadOutlined /></template>
          刷新
        </YButton>
      </a-space>
    </template>

    <a-spin :spinning="loading && !status">
      <div class="central-backup-body">
        <a-alert
          type="warning"
          show-icon
          class="secret-warning-alert"
          :message="CENTRAL_BACKUP_SECRET_WARNING"
        >
          <template #icon><SafetyCertificateOutlined /></template>
        </a-alert>

        <!-- 卡片 1：中央库备份 -->
        <a-card title="中央库备份" size="small" class="backup-card">
          <template #extra>
            <a-tooltip :title="permissions.canTriggerBackup ? '' : '只读账号不能触发备份'">
              <YButton
                type="primary"
                size="small"
                :disabled="!permissions.canTriggerBackup || Boolean(status?.running)"
                :loading="runningBackup"
                @click="handleRunBackup"
              >
                <template #icon><CloudUploadOutlined /></template>
                立即备份
              </YButton>
            </a-tooltip>
          </template>

          <a-alert
            v-if="status?.last?.status === 'failed' && status.last.error"
            type="error"
            show-icon
            class="backup-error-alert"
            message="最近一次备份失败"
            :description="status.last.error"
          />

          <a-descriptions :column="2" size="small" bordered class="backup-descriptions">
            <a-descriptions-item label="备份服务器" :span="2">
              {{ serverLabel }}
            </a-descriptions-item>
            <a-descriptions-item label="远端备份目录">
              <code>{{ status?.settings?.remoteDir || '-' }}</code>
            </a-descriptions-item>
            <a-descriptions-item label="每日定时">
              <span>每天 {{ status?.settings?.scheduleTime || '02:30' }}</span>
              <a-tag :color="status?.settings?.enabled ? 'green' : 'default'" style="margin-left: 8px">
                {{ status?.settings?.enabled ? '已开启' : '已关闭' }}
              </a-tag>
            </a-descriptions-item>
            <a-descriptions-item label="上次备份时间">
              {{ formatBackupDateTime(status?.last?.runAt) }}
              <span v-if="backupRunContext" class="trigger-hint">
                （{{ backupRunContext }}）
              </span>
            </a-descriptions-item>
            <a-descriptions-item label="执行结果">
              <a-tag :color="backupStatusTag.color">{{ backupStatusTag.text }}</a-tag>
              <span v-if="hasLastDuration" class="duration-hint">
                耗时 {{ formatDuration(status?.last?.durationMs) }}
              </span>
            </a-descriptions-item>
            <a-descriptions-item label="上次成功时间" :span="2">
              {{ formatBackupDateTime(status?.lastSuccessAt) }}
            </a-descriptions-item>
            <a-descriptions-item label="最近成功文件" :span="2">
              <code>{{ status?.last?.fileName || '-' }}</code>
            </a-descriptions-item>
            <a-descriptions-item label="文件大小">
              {{ status?.last?.fileSize ? formatBackupSize(status.last.fileSize) : '-' }}
            </a-descriptions-item>
            <a-descriptions-item label="SHA-256">
              <template v-if="status?.last?.sha256">
                <a-tooltip :title="status.last.sha256">
                  <code>{{ truncateSha256(status.last.sha256, 16) }}</code>
                </a-tooltip>
                <a-button type="link" size="small" class="copy-sha-btn" @click="handleCopySha">
                  <template #icon>
                    <CheckOutlined v-if="copiedSha" />
                    <CopyOutlined v-else />
                  </template>
                  复制
                </a-button>
              </template>
              <span v-else>-</span>
            </a-descriptions-item>
          </a-descriptions>

          <a-divider orientation="left" class="section-divider">备份目标配置</a-divider>

          <div v-if="permissions.canEditSettings" class="backup-config-form">
            <div class="config-row">
              <label class="config-label">备份服务器</label>
              <a-select
                v-model:value="form.serverId"
                placeholder="请选择接收异地备份的服务器"
                allow-clear
                show-search
                option-filter-prop="label"
                :options="serverOptions"
                class="config-control"
              />
            </div>
            <div class="config-row">
              <label class="config-label">远端目录</label>
              <div class="config-control-wrap">
                <a-input
                  v-model:value="form.remoteDir"
                  placeholder="/bak/wangyancong-yuyan"
                  :status="dirValidation.valid ? '' : 'error'"
                />
                <div v-if="!dirValidation.valid" class="dir-error-tip">{{ dirValidation.error }}</div>
                <div v-else class="dir-help-tip">需至少两级绝对路径，且备份 SSH 账号对该目录有直接写权限</div>
              </div>
            </div>
            <div class="config-row config-row--switch">
              <label class="config-label">每日自动备份</label>
              <a-switch v-model:checked="form.enabled" />
              <span class="switch-tip">开启后每天 {{ status?.settings?.scheduleTime || '02:30' }} 自动执行</span>
              <YButton
                type="primary"
                size="small"
                class="save-config-btn"
                :loading="saving"
                :disabled="!dirValidation.valid"
                @click="handleSaveSettings"
              >
                保存配置
              </YButton>
            </div>
          </div>
          <div v-else class="readonly-settings-tip">
            仅管理员（admin）可修改备份服务器、远端目录与定时备份开关。
          </div>
          <div v-if="status?.settings?.updatedAt || status?.settings?.updatedBy" class="settings-updated-meta">
            最后修改：{{ status?.settings?.updatedBy || '未知' }} 于 {{ formatBackupDateTime(status?.settings?.updatedAt) }}
          </div>
        </a-card>

        <!-- 卡片 2：Nginx 配置巡检 -->
        <a-card title="Nginx 配置巡检" size="small" class="backup-card">
          <template #extra>
            <a-tooltip :title="permissions.canTriggerPatrol ? '' : '只读账号不能触发巡检'">
              <YButton
                size="small"
                :disabled="!permissions.canTriggerPatrol || Boolean(status?.patrolRunning)"
                :loading="runningPatrol"
                @click="handleRunPatrol"
              >
                <template #icon><ScanOutlined /></template>
                立即巡检
              </YButton>
            </a-tooltip>
          </template>

          <template v-if="status?.patrol">
            <div class="patrol-summary-grid">
              <div class="patrol-stat">
                <span class="stat-label">上次巡检时间</span>
                <span class="stat-value">{{ formatBackupDateTime(status.patrol.finishedAt || status.patrol.startedAt) }}</span>
              </div>
              <div class="patrol-stat">
                <span class="stat-label">巡检服务器</span>
                <span class="stat-value">{{ status.patrol.servers }} 台</span>
              </div>
              <div class="patrol-stat">
                <span class="stat-label">检查文件</span>
                <span class="stat-value">{{ status.patrol.filesChecked }} 份</span>
              </div>
              <div class="patrol-stat">
                <span class="stat-label">更新快照</span>
                <span class="stat-value">{{ status.patrol.filesUpdated }} 份</span>
              </div>
            </div>

            <div v-if="status.patrol.failures?.length" class="patrol-block">
              <div class="block-title">失败服务器（{{ status.patrol.failures.length }}）</div>
              <div v-for="fail in status.patrol.failures" :key="fail.serverId" class="patrol-failure-item">
                <a-tag color="error">{{ fail.serverName || `服务器 #${fail.serverId}` }}</a-tag>
                <span class="failure-reason">{{ fail.error }}</span>
              </div>
            </div>

            <div v-if="status.patrol.filesSkipped?.length" class="patrol-block">
              <div class="block-title">跳过文件（{{ status.patrol.filesSkipped.length }}）</div>
              <div v-for="skip in status.patrol.filesSkipped" :key="skip.path" class="patrol-skip-item">
                <code>{{ skip.path }}</code>
                <a-tag>{{ skip.reason }}</a-tag>
              </div>
            </div>

            <div class="patrol-block">
              <div class="block-title">SSL 证书到期状态（{{ patrolCertRows.length }}）</div>
              <div v-if="!patrolCertRows.length" class="empty-patrol-tip">未检测到 `ssl_certificate` 指令</div>
              <div v-else class="cert-list">
                <div v-for="cert in patrolCertRows" :key="`${cert.serverId}:${cert.path}`" class="cert-row">
                  <div class="cert-meta">
                    <span class="cert-server">{{ cert.serverName || `服务器 #${cert.serverId}` }}</span>
                    <code class="cert-path">{{ cert.path }}</code>
                  </div>
                  <div class="cert-status">
                    <span class="cert-date">{{ cert.notAfterDisplay }}</span>
                    <a-tag :color="cert.expiry.color">{{ cert.expiry.label }}</a-tag>
                  </div>
                </div>
              </div>
            </div>
          </template>
          <div v-else class="empty-patrol-tip">
            尚未执行过 Nginx 配置巡检。保存配置、同步站点或初始化托管实例时会自动更新单份快照，点击「立即巡检」可全量扫描所有服务器与证书到期时间。
          </div>
        </a-card>
      </div>
    </a-spin>
  </a-drawer>
</template>

<style scoped lang="less">
@import './style.less';
</style>
