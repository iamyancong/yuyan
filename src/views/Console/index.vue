<script setup lang="ts">
import { DeleteOutlined, CodeOutlined } from '@ant-design/icons-vue';
import { useVpnConsole } from './hooks/useVpnConsole';
import { FILTER_OPTIONS } from './constant';

defineOptions({ name: 'VpnConsole' });

const {
  filterType,
  filteredLogs,
  terminalRef,
  clearLogs,
} = useVpnConsole();
</script>

<template>
  <div class="console-container">
    <div class="console-header" data-tauri-drag-region>
      <h1>实时日志终端</h1>
      
      <div class="console-actions">
        <a-radio-group v-model:value="filterType" button-style="solid">
          <a-radio-button 
            v-for="opt in FILTER_OPTIONS" 
            :key="opt.value" 
            :value="opt.value"
          >
            {{ opt.label }}
          </a-radio-button>
        </a-radio-group>
        <a-button type="default" danger @click="clearLogs">
          <template #icon><DeleteOutlined /></template>
          清空面板
        </a-button>
      </div>
    </div>

    <!-- 终端日志滚动区域 -->
    <div ref="terminalRef" class="terminal-window">
      <template v-if="filteredLogs.length > 0">
        <div 
          v-for="(log, idx) in filteredLogs" 
          :key="idx" 
          class="log-line"
          :class="log.vpnType"
        >
          <span class="log-time">[{{ log.time }}]</span>
          <span class="log-tag" :class="log.vpnType">
            [{{ log.vpnType === 'fortinet' ? 'Fortinet' : 'aTrust' }}]
          </span>
          <span class="log-text">{{ log.text }}</span>
        </div>
      </template>
      <div v-else class="terminal-empty">
        <span class="prompt-symbol">>_</span>
        <span>当前无实时连接日志，请在控制中心拉起 VPN 登录。</span>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
