<script setup lang="ts">
import { ref } from 'vue';
import { message } from 'ant-design-vue';
import { CopyOutlined, CheckOutlined, QuestionCircleOutlined } from '@ant-design/icons-vue';
import { MAC_QUARANTINE_COMMAND, MAC_QUARANTINE_TIP } from '../constant';

defineOptions({ name: 'MacQuarantineGuide' });

const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * 复制解除隔离终端命令到系统剪贴板。
 */
const copyCommand = async () => {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(MAC_QUARANTINE_COMMAND);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = MAC_QUARANTINE_COMMAND;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }

    copied.value = true;
    message.success('已复制解除隔离命令，请在终端中粘贴运行');

    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch (err) {
    console.error('复制命令失败:', err);
    message.error('复制失败，请手动选择复制');
  }
};
</script>

<template>
  <div class="mac-quarantine-card">
    <div class="quarantine-header">
      <div class="header-left">
        <span class="mac-traffic-lights">
          <span class="dot dot-close" />
          <span class="dot dot-min" />
          <span class="dot dot-max" />
        </span>
        <span class="quarantine-title">macOS 首次打开提示已损坏？</span>
      </div>
      <a-tooltip title="macOS Gatekeeper 安全防护机制可能拦截未签名应用，在终端运行该命令即可信任运行">
        <QuestionCircleOutlined class="quarantine-help-icon" />
      </a-tooltip>
    </div>

    <div class="command-box">
      <div class="command-content">
        <span class="command-prompt">$</span>
        <code class="command-text" :title="MAC_QUARANTINE_COMMAND">{{ MAC_QUARANTINE_COMMAND }}</code>
      </div>
      <button
        type="button"
        class="btn-copy-command"
        :class="{ 'is-copied': copied }"
        :title="copied ? '已复制' : '复制命令'"
        @click="copyCommand"
      >
        <CheckOutlined v-if="copied" class="copy-icon" />
        <CopyOutlined v-else class="copy-icon" />
        <span class="copy-text">{{ copied ? '已复制' : '复制' }}</span>
      </button>
    </div>

    <div class="quarantine-footer">
      <span>{{ MAC_QUARANTINE_TIP }}</span>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './MacQuarantineGuide.less';
</style>
