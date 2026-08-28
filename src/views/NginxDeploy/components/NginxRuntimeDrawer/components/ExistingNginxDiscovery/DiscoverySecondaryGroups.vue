<script setup lang="ts">
import { ExportOutlined, WarningOutlined } from '@ant-design/icons-vue';
import { YButton } from '@ycwang-dev/components/lite';
import type { NginxDiscoveryDiagnostic, NginxDiscoveryRuntime } from '@/api/deploy';

defineOptions({ name: 'NginxDiscoverySecondaryGroups' });

/** 已接入与需处理折叠组属性。 */
interface DiscoverySecondaryGroupsProps {
  connectedRuntimes: NginxDiscoveryRuntime[];
  diagnosticRuntimes: NginxDiscoveryRuntime[];
  diagnostics: NginxDiscoveryDiagnostic[];
}

defineProps<DiscoverySecondaryGroupsProps>();
const emit = defineEmits<{ openConnected: [instanceId: number] }>();
</script>

<template>
  <a-collapse class="nginx-discovery-secondary" ghost>
    <a-collapse-panel v-if="connectedRuntimes.length" key="connected">
      <template #header>已接入（{{ connectedRuntimes.length }}）</template>
      <div class="nginx-discovery-secondary__rows">
        <div v-for="runtime in connectedRuntimes" :key="runtime.id" class="nginx-discovery-secondary__row">
          <div>
            <strong>{{ runtime.connectedInstance?.name || `实例 #${runtime.connectedInstanceId}` }}</strong>
            <span>{{ runtime.binaryPath }} · {{ runtime.mainConfigPath || '未识别主配置' }}</span>
          </div>
          <YButton size="small" @click="emit('openConnected', Number(runtime.connectedInstanceId))">
            <ExportOutlined />打开已有实例
          </YButton>
        </div>
      </div>
    </a-collapse-panel>

    <a-collapse-panel v-if="diagnosticRuntimes.length || diagnostics.length" key="diagnostics">
      <template #header>需处理（{{ diagnosticRuntimes.length || diagnostics.length }}）</template>
      <div class="nginx-discovery-secondary__rows">
        <div v-for="runtime in diagnosticRuntimes" :key="runtime.id" class="nginx-discovery-secondary__row">
          <WarningOutlined />
          <div>
            <strong>{{ runtime.binaryPath }}</strong>
            <span>{{ runtime.diagnostics[0]?.summary || '没有可接入的静态站点' }}</span>
            <details v-if="runtime.diagnostics[0]?.detail">
              <summary>查看原始详情</summary>
              <code>{{ runtime.diagnostics[0]?.detail }}</code>
            </details>
          </div>
        </div>
        <div v-for="diagnostic in diagnostics" :key="`${diagnostic.code}:${diagnostic.summary}`" class="nginx-discovery-secondary__row">
          <WarningOutlined />
          <div>
            <strong>{{ diagnostic.summary }}</strong>
            <span v-if="diagnostic.action">{{ diagnostic.action }}</span>
            <details v-if="diagnostic.detail">
              <summary>查看原始详情</summary>
              <code>{{ diagnostic.detail }}</code>
            </details>
          </div>
        </div>
      </div>
    </a-collapse-panel>
  </a-collapse>
</template>

<style scoped lang="less">
@import './secondary-groups.less';
</style>
