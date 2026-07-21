<script setup lang="ts">
import { YButton } from '@ycwang-dev/components/lite';
import type { AgentClientStatus } from '@/api/agent';

/** 客户端安装列表属性。 */
defineProps<{ clients: AgentClientStatus[] }>();

const emit = defineEmits<{
  /** 安装、修复或卸载客户端。 */
  (event: 'change', client: AgentClientStatus['client'], action: 'install' | 'uninstall'): void;
}>();
</script>

<template>
  <div class="ai-client-list">
    <div v-for="item in clients" :key="item.client" class="ai-client-item">
      <div>
        <strong>{{ item.label }}</strong>
        <small>{{ item.installed ? (item.needsRepair ? '路径变化，需要修复' : '已接入 yuyan-mcp-server') : '尚未安装' }}</small>
      </div>
      <div class="ai-client-item__actions">
        <YButton size="small" :type="item.installed && !item.needsRepair ? 'default' : 'primary'" @click="emit('change', item.client, 'install')">
          {{ item.installed ? (item.needsRepair ? '修复' : '重装') : '安装' }}
        </YButton>
        <YButton v-if="item.installed" size="small" danger @click="emit('change', item.client, 'uninstall')">卸载</YButton>
      </div>
    </div>
  </div>
</template>
