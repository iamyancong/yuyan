<script setup lang="ts">
import { computed } from 'vue';
import { DeleteOutlined, LaptopOutlined, LinkOutlined } from '@ant-design/icons-vue';
import { YButton } from '@ycwang-dev/components/lite';
import type { CentralDevice, CentralMe } from '@/api/centralIdentity';
import type { SecureAccountState } from '@/services/secureAuth';

interface Props {
  account: SecureAccountState | null;
  centralMe: CentralMe | null;
  devices: CentralDevice[];
  loading?: boolean;
}

const props = withDefaults(defineProps<Props>(), { loading: false });
const emit = defineEmits<{
  /** 撤销指定设备。 */
  revoke: [deviceId: string];
}>();

/** 当前账号的显示名称。 */
const accountName = computed(() => props.account?.gitlabDisplayName || props.account?.gitlabUsername || 'GitLab 账号');

/** 当前账号名称的头像占位字符。 */
const accountInitial = computed(() => accountName.value.trim().slice(0, 1).toUpperCase() || 'Y');

/** 把 ISO 时间转换为紧凑的本地时间。 */
const formatLastSeen = (value: string) => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value || '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
};
</script>

<template>
  <div class="ai-identity-card">
    <a-alert v-if="!account" type="warning" message="请先登录 GitLab，登录后可管理账号设备与跨设备策略。" show-icon />

    <template v-else>
      <div class="ai-account-summary">
        <div class="ai-account-summary__avatar">
          <a-avatar :size="46" :src="account.gitlabAvatarUrl">{{ accountInitial }}</a-avatar>
          <span class="ai-account-summary__status" aria-hidden="true" />
        </div>

        <div class="ai-account-summary__identity">
          <div class="ai-account-summary__name-row">
            <strong>{{ accountName }}</strong>
            <span class="ai-account-summary__session">
              <LinkOutlined /> {{ centralMe ? '中央会话已连接' : '正在连接中央会话' }}
            </span>
          </div>
          <span>@{{ account.gitlabUsername }} · {{ account.gitlabHost }}</span>
        </div>

        <dl class="ai-account-summary__facts">
          <div>
            <dt>账号标识</dt>
            <dd :title="account.accountId">{{ account.accountId }}</dd>
          </div>
          <div>
            <dt>可信设备</dt>
            <dd>{{ devices.filter((device) => device.status === 'active').length }} 台</dd>
          </div>
        </dl>
      </div>

      <div class="ai-device-heading">
        <div>
          <strong>登录设备</strong>
          <span>设备凭据独立保存，可随时撤销其他设备。</span>
        </div>
        <a-tag>{{ devices.length }} 台</a-tag>
      </div>

      <div class="ai-device-list">
        <article v-for="device in devices" :key="device.deviceId" class="ai-device-item">
          <span class="ai-device-item__icon"><LaptopOutlined /></span>
          <div class="ai-device-item__content">
            <div class="ai-device-item__title">
              <strong>{{ device.deviceName || device.platform || '未命名设备' }}</strong>
              <a-tag v-if="device.deviceId === account.deviceId" color="success">当前设备</a-tag>
              <a-tag v-else-if="device.status === 'revoked'">已撤销</a-tag>
            </div>
            <span>{{ device.platform }} · 最近在线 {{ formatLastSeen(device.lastSeenAt) }}</span>
            <code :title="device.deviceId">{{ device.deviceId }}</code>
          </div>
          <a-popconfirm
            v-if="device.deviceId !== account.deviceId && device.status !== 'revoked'"
            title="撤销后该设备的会话和待执行任务会立即失效，确定继续吗？"
            ok-text="撤销"
            cancel-text="取消"
            @confirm="emit('revoke', device.deviceId)"
          >
            <YButton danger size="small"><DeleteOutlined /> 撤销</YButton>
          </a-popconfirm>
        </article>
      </div>

      <a-empty v-if="!loading && !devices.length" description="暂无可管理设备" :image="undefined" />
    </template>
  </div>
</template>

<style scoped lang="less">
@import '../style.less';
</style>
