<script setup lang="ts">
import { computed, ref } from 'vue';
import { ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons-vue';
import { YButton } from '@ycwang-dev/components/lite';
import type { DeployServer, NginxInstancePayload } from '@/api/deploy';
import DiscoverySecondaryGroups from './DiscoverySecondaryGroups.vue';
import RuntimeDiscoveryGroup from './RuntimeDiscoveryGroup.vue';
import { useExistingNginxDiscovery } from './hooks/useExistingNginxDiscovery';
import { groupNginxDiscoveryRuntimes } from './presentationPolicy';
import type { ExistingNginxSelection } from './selectionPolicy';

defineOptions({ name: 'ExistingNginxDiscovery' });

/** 已有 Nginx 智能发现属性。 */
interface ExistingNginxDiscoveryProps {
  serverId: number;
  server: DeployServer | null;
  open: boolean;
  useSudo: boolean;
}

const props = defineProps<ExistingNginxDiscoveryProps>();
const emit = defineEmits<{
  select: [value: Partial<NginxInstancePayload>];
  updateUseSudo: [value: boolean];
  openConnected: [instanceId: number];
}>();
const { errorMessage, loading, result, scan, selectedKey, staleResult } = useExistingNginxDiscovery({
  serverId: () => props.serverId,
  open: () => props.open,
  useSudo: () => props.useSudo,
});
const manualMode = ref(false);
const changingSelection = ref(false);
const groups = computed(() => groupNginxDiscoveryRuntimes(result.value?.runtimes || []));
const selectedCandidate = computed(() => groups.value.candidates.find((item) => item.key === selectedKey.value) || null);
const scanDiagnostics = computed(() => result.value?.diagnostics.filter((item) => item.scope === 'scan') || []);
const hasPartialWarning = computed(() => Boolean(result.value?.diagnostics.some((item) => item.severity !== 'info')));
const needsSudo = computed(() => result.value?.diagnostics.some((item) => item.code === 'permission_denied') && !props.useSudo);
const serverSummary = computed(() => result.value?.server || {
  id: props.server?.id || 0,
  name: props.server?.name || '当前服务器',
  host: props.server?.host || '-',
  sshPort: props.server?.port || 22,
});
const scannedTime = computed(() => result.value?.scannedAt
  ? new Date(result.value.scannedAt).toLocaleTimeString('zh-CN', { hour12: false })
  : '扫描中');

/** 应用发现站点并同步选中态。 */
const applySelection = (selection: ExistingNginxSelection) => {
  if (staleResult.value) return;
  selectedKey.value = selection.key;
  changingSelection.value = false;
  manualMode.value = false;
  emit('select', selection.formPatch);
};
</script>

<template>
  <section class="existing-nginx-discovery">
    <header class="existing-nginx-discovery__header">
      <div class="existing-nginx-discovery__server">
        <strong><SafetyCertificateOutlined />服务器：{{ serverSummary.name }} · {{ serverSummary.host }}:{{ serverSummary.sshPort }}</strong>
        <span>只读扫描，不初始化、不修改配置、不重载</span>
      </div>
      <div class="existing-nginx-discovery__actions">
        <a-tag>{{ scannedTime }}</a-tag><a-tag>{{ useSudo ? 'sudo 开' : 'sudo 关' }}</a-tag><a-tag>{{ groups.candidates.length }} 个候选</a-tag>
        <YButton size="small" :loading="loading" @click="() => scan()"><ReloadOutlined />重新扫描</YButton>
      </div>
    </header>

    <a-alert v-if="errorMessage" :type="result ? 'warning' : 'error'" show-icon :message="result ? `刷新失败，旧结果已过期：${errorMessage}` : errorMessage" />
    <a-alert v-else-if="hasPartialWarning && groups.candidates.length" type="warning" show-icon message="扫描已返回有效候选，部分运行实例需要处理；详情见下方“需处理”。" />
    <div v-if="needsSudo && result && groups.candidates.length" class="existing-nginx-discovery__fallback">
      <span>部分配置读取权限不足，可保持现有候选或提升权限重试。</span>
      <YButton size="small" @click="emit('updateUseSudo', true)">使用 sudo 重新扫描</YButton>
    </div>

    <a-skeleton v-if="loading && !result" active :paragraph="{ rows: 2 }" />
    <div v-else-if="errorMessage && !result" class="existing-nginx-discovery__fallback">
      <YButton size="small" type="primary" @click="() => scan({ clearResult: true })">重试</YButton>
      <YButton size="small" @click="manualMode = true">手动填写</YButton>
    </div>

    <div v-else-if="manualMode" class="existing-nginx-discovery__selected">
      <span>已切换为手动填写，扫描不是保存实例的前置条件。</span>
      <YButton type="link" size="small" @click="manualMode = false">展开扫描结果</YButton>
    </div>
    <div v-else-if="selectedCandidate && !changingSelection" class="existing-nginx-discovery__selected">
      <div><strong>已采用：{{ selectedCandidate.endpoint?.url || selectedCandidate.site.listenValues[0] }}</strong><span>root：{{ selectedCandidate.root.path }}</span></div>
      <YButton type="link" size="small" @click="changingSelection = true">更换站点</YButton>
    </div>

    <template v-else-if="result">
      <div v-if="groups.selectableRuntimes.length" class="existing-nginx-discovery__section">
        <div class="existing-nginx-discovery__section-title"><strong>可接入</strong><span>每个运行实例先展示 5 项；推荐项也必须手动采用</span></div>
        <RuntimeDiscoveryGroup
          v-for="runtime in groups.selectableRuntimes"
          :key="runtime.id"
          :runtime="runtime"
          :selected-key="selectedKey"
          :recommended-key="groups.recommendedKey"
          :disabled="staleResult"
          @select="applySelection"
        />
      </div>
      <div v-else class="existing-nginx-discovery__empty">
        <strong>没有可接入的静态站点</strong><span>可查看诊断后重试，或直接手动填写下方配置。</span>
        <div><YButton v-if="needsSudo" size="small" type="primary" @click="emit('updateUseSudo', true)">使用 sudo 重新扫描</YButton><YButton size="small" @click="manualMode = true">手动填写</YButton></div>
      </div>
      <DiscoverySecondaryGroups
        :connected-runtimes="groups.connectedRuntimes"
        :diagnostic-runtimes="groups.diagnosticRuntimes"
        :diagnostics="scanDiagnostics"
        @open-connected="emit('openConnected', $event)"
      />
    </template>

    <p class="existing-nginx-discovery__manual">扫描只提供建议；采用后仍可修改下方表单，重新扫描不会自动覆盖。</p>
  </section>
</template>

<style scoped lang="less">
@import './style.less';
</style>
