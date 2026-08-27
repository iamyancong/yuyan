<script setup lang="ts">
import { computed } from 'vue';
import { ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons-vue';
import { YButton } from '@ycwang-dev/components/lite';
import type { NginxInstancePayload } from '@/api/deploy';
import RuntimeDiscoveryGroup from './RuntimeDiscoveryGroup.vue';
import { useExistingNginxDiscovery } from './hooks/useExistingNginxDiscovery';
import type { ExistingNginxSelection } from './selectionPolicy';

defineOptions({ name: 'ExistingNginxDiscovery' });

/** 已有 Nginx 智能发现属性。 */
interface ExistingNginxDiscoveryProps {
  serverId: number;
  open: boolean;
  useSudo: boolean;
}

const props = defineProps<ExistingNginxDiscoveryProps>();
const emit = defineEmits<{ select: [value: Partial<NginxInstancePayload>] }>();
const { errorMessage, loading, result, scan, selectedKey } = useExistingNginxDiscovery({
  serverId: () => props.serverId,
  open: () => props.open,
  useSudo: () => props.useSudo,
});

/** 当前是否没有发现任何物理 Nginx。 */
const isEmpty = computed(() => !loading.value && !result.value?.runtimes.length);

/** 应用发现站点并同步选中态。 */
const applySelection = (selection: ExistingNginxSelection) => {
  selectedKey.value = selection.key;
  emit('select', selection.formPatch);
};
</script>

<template>
  <section class="existing-nginx-discovery">
    <header class="existing-nginx-discovery__header">
      <div>
        <strong><SafetyCertificateOutlined />智能识别宿主机 Nginx</strong>
        <span>只读扫描运行进程和生效配置，不会初始化、修改配置或执行重载</span>
      </div>
      <YButton size="small" :loading="loading" @click="scan"><ReloadOutlined />重新扫描</YButton>
    </header>

    <a-alert v-if="useSudo" type="info" show-icon message="本次使用非交互 sudo -n；若服务器只允许 sudo -i 输入密码，将自动降级为手动接入。" />
    <a-alert v-if="errorMessage" type="warning" show-icon :message="errorMessage" />
    <a-alert v-for="warning in result?.warnings || []" :key="warning" type="warning" show-icon :message="warning" />
    <a-alert v-if="result?.truncated" type="warning" show-icon message="扫描结果已达到安全上限；若目标未显示，请继续手动填写或缩小服务器上的候选范围后重新扫描。" />

    <a-spin :spinning="loading" tip="正在识别 Nginx 进程、server 端口和 HTML 根目录...">
      <div v-if="result?.runtimes.length" class="existing-nginx-discovery__runtimes">
        <RuntimeDiscoveryGroup
          v-for="runtime in result.runtimes"
          :key="runtime.id"
          :runtime="runtime"
          :selected-key="selectedKey"
          @select="applySelection"
        />
      </div>
      <a-empty v-else-if="isEmpty" description="没有自动发现可用 Nginx，可继续填写下方路径和命令" />
    </a-spin>

    <p class="existing-nginx-discovery__manual">扫描只是辅助能力；选择后仍可修改下方自动回填的实例配置。</p>
  </section>
</template>

<style scoped lang="less">
@import './style.less';
</style>
