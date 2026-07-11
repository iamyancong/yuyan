<script setup lang="ts">
import { computed } from 'vue';
import {
  SafetyOutlined,
  LinkOutlined,
  UnlockOutlined,
  PoweroffOutlined,
  DashboardOutlined,
} from '@ant-design/icons-vue';
import { useVpnDashboard } from './hooks/useVpnDashboard';

defineOptions({ name: 'VpnDashboard' });

const {
  fortinetState,
  atrustState,
  sudoVisible,
  sudoPasswordInput,
  sudoVerifying,
  submitSudoPassword,
  toggleFortinet,
  toggleAtrust,
  connectBoth,
  disconnectAll,
  mfaVisible,
  mfaPrompt,
  mfaCodeInput,
  mfaVerifying,
  submitMfaCode,
  captchaVisible,
  captchaUrl,
} = useVpnDashboard();

/** 格式化计时器为 hh:mm:ss 格式 */
const formatUptime = (seconds: number) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((v) => v.toString().padStart(2, '0')).join(':');
};

/** 检查是否任一 VPN 在连接中 */
const isAnyConnecting = computed(() => {
  return fortinetState.value.status === 'connecting' || atrustState.value.status === 'connecting';
});
</script>

<template>
  <div class="dashboard-container">
    <div class="dashboard-header" data-tauri-drag-region>
      <h1>VPN 控制中心</h1>
      <div class="global-actions">
        <a-button 
          type="primary" 
          :disabled="isAnyConnecting"
          @click="connectBoth"
        >
          <template #icon><LinkOutlined /></template>
          同时连接 (Both)
        </a-button>
        <a-button 
          type="primary" 
          danger
          @click="disconnectAll"
        >
          <template #icon><PoweroffOutlined /></template>
          全部断开
        </a-button>
      </div>
    </div>

    <div class="vpn-cards-row">
      <!-- 1. Fortinet 公司 VPN 卡片 -->
      <div 
        class="vpn-glass-card type-fortinet" 
        :class="`status-${fortinetState.status}`"
      >
        <div class="card-aurora-glow" />
        
        <div class="card-header-area">
          <div class="card-title">
            <div class="card-icon">
              <DashboardOutlined />
            </div>
            <div>
              <h2>Fortinet VPN</h2>
              <div style="font-size: 12px; color: #64748b; margin-top: 2px;">公司内网分流通道</div>
            </div>
          </div>
          <div class="status-badge" :class="fortinetState.status">
            <span class="led-indicator" :class="fortinetState.status" />
            {{ fortinetState.message }}
          </div>
        </div>

        <div class="card-body-area">
          <div class="stat-item">
            <span class="stat-label">连接状态</span>
            <span class="stat-value">{{ fortinetState.message }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">分配网卡 IP</span>
            <span class="stat-value mono">{{ fortinetState.virtualIp || '--' }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">持续运行时间</span>
            <span class="stat-value mono">{{ formatUptime(fortinetState.uptime) }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">默认分流路由</span>
            <span class="stat-value">192.168.100.0/24</span>
          </div>
        </div>

        <div class="card-actions-area">
          <a-button 
            :type="fortinetState.status === 'connected' ? 'default' : 'primary'"
            :danger="fortinetState.status === 'connected'"
            :loading="fortinetState.status === 'connecting' || fortinetState.status === 'disconnecting'"
            @click="toggleFortinet"
          >
            {{ fortinetState.status === 'connected' ? '断开连接' : '一键登录' }}
          </a-button>
        </div>
      </div>

      <!-- 2. aTrust 高校 VPN 卡片 -->
      <div 
        class="vpn-glass-card type-atrust" 
        :class="`status-${atrustState.status}`"
      >
        <div class="card-aurora-glow" />

        <div class="card-header-area">
          <div class="card-title">
            <div class="card-icon">
              <SafetyOutlined />
            </div>
            <div>
              <h2>aTrust VPN</h2>
              <div style="font-size: 12px; color: #64748b; margin-top: 2px;">科研分流 TUN/代理通道</div>
            </div>
          </div>
          <div class="status-badge" :class="atrustState.status">
            <span class="led-indicator" :class="atrustState.status" />
            {{ atrustState.message }}
          </div>
        </div>

        <div class="card-body-area">
          <div class="stat-item">
            <span class="stat-label">连接状态</span>
            <span class="stat-value">{{ atrustState.message }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">分配网卡 IP</span>
            <span class="stat-value mono">{{ atrustState.virtualIp || '--' }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">持续运行时间</span>
            <span class="stat-value mono">{{ formatUptime(atrustState.uptime) }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">本地监听端口</span>
            <span class="stat-value">SOCKS5:1080 / HTTP:1081</span>
          </div>
        </div>

        <div class="card-actions-area">
          <a-button 
            :type="atrustState.status === 'connected' ? 'default' : 'primary'"
            :danger="atrustState.status === 'connected'"
            :loading="atrustState.status === 'connecting' || atrustState.status === 'disconnecting'"
            @click="toggleAtrust"
          >
            {{ atrustState.status === 'connected' ? '断开连接' : '一键登录' }}
          </a-button>
        </div>
      </div>
    </div>

    <!-- macOS 提权输入对话框 -->
    <a-modal
      v-model:open="sudoVisible"
      title="macOS 系统权限验证"
      :confirm-loading="sudoVerifying"
      @ok="submitSudoPassword"
      destroy-on-close
    >
      <div class="sudo-dialog-body">
        <a-alert
          type="info"
          show-icon
          class="alert-tip"
          message="提权说明"
          description="因为配置虚拟网口和系统分流路由需要管理员特权，请输入您的 macOS 用户密码进行提权。该密码仅留存在本地 App 进程内存中，绝不上传、不落盘。"
        />
        <div style="margin-bottom: 8px; font-weight: 600;">Sudo 密码</div>
        <a-input-password
          v-model:value="sudoPasswordInput"
          placeholder="请输入您的 macOS 开机锁屏密码"
          autofocus
          @pressEnter="submitSudoPassword"
        >
          <template #prefix><UnlockOutlined style="color: #94a3b8" /></template>
        </a-input-password>
      </div>
    </a-modal>

    <!-- VPN 二次认证对话框 (MFA/验证码/短信码) -->
    <a-modal
      v-model:open="mfaVisible"
      title="VPN 二次认证授权"
      :confirm-loading="mfaVerifying"
      @ok="submitMfaCode"
      destroy-on-close
    >
      <div class="sudo-dialog-body">
        <a-alert
          type="warning"
          show-icon
          class="alert-tip"
          message="需要二次验证"
          :description="mfaPrompt"
        />
        <div style="margin-bottom: 8px; font-weight: 600; margin-top: 16px;">请输入验证码</div>
        <a-input
          v-model:value="mfaCodeInput"
          placeholder="请输入二次验证码 / 短信验证码"
          autofocus
          @pressEnter="submitMfaCode"
        >
          <template #prefix><UnlockOutlined style="color: #94a3b8" /></template>
        </a-input>
      </div>
    </a-modal>

    <!-- VPN 图形 behavior 验证码弹窗 (内嵌 Webview) -->
    <a-modal
      v-model:open="captchaVisible"
      title="VPN 安全行为验证"
      :footer="null"
      :width="480"
      destroy-on-close
      :mask-closable="false"
      :body-style="{ padding: '12px 0' }"
    >
      <div style="width: 100%; height: 420px; overflow: hidden; border-radius: 8px;">
        <iframe
          v-if="captchaUrl"
          :src="captchaUrl"
          style="width: 100%; height: 100%; border: none; background: #ffffff;"
        />
      </div>
    </a-modal>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
