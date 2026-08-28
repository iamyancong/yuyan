<script setup lang="ts">
import { computed, ref } from 'vue';
import { FolderOutlined, GlobalOutlined } from '@ant-design/icons-vue';
import { YButton } from '@ycwang-dev/components/lite';
import type { NginxDiscoveryRuntime } from '@/api/deploy';
import { createExistingNginxSelection, type ExistingNginxSelection } from './selectionPolicy';
import {
  createRuntimeDiscoveryCandidates,
  formatDiscoveryServerNames,
} from './presentationPolicy';

defineOptions({ name: 'NginxRuntimeDiscoveryGroup' });

/** 单个物理 Nginx 可接入候选属性。 */
interface RuntimeDiscoveryGroupProps {
  runtime: NginxDiscoveryRuntime;
  selectedKey: string;
  recommendedKey: string;
  disabled: boolean;
}

const props = defineProps<RuntimeDiscoveryGroupProps>();
const emit = defineEmits<{ select: [value: ExistingNginxSelection] }>();
const expanded = ref(false);
const candidates = computed(() => createRuntimeDiscoveryCandidates(props.runtime));
const visibleCandidates = computed(() => expanded.value ? candidates.value : candidates.value.slice(0, 5));

/** 格式化结构化 listen。 */
const formatListen = (candidate: (typeof candidates.value)[number]) => candidate.site.listens.map((listen) => {
  if (listen.transport === 'unix') return `unix:${listen.address}`;
  return `${listen.address || '*'}:${listen.port}${listen.ssl ? ' ssl' : ''}`;
}).join(' · ');

/** 采用候选并交由父级回填表单。 */
const selectCandidate = (candidate: (typeof candidates.value)[number]) => {
  if (props.disabled) return;
  emit('select', createExistingNginxSelection(candidate.runtime, candidate.site, candidate.root));
};
</script>

<template>
  <section class="nginx-discovery-runtime">
    <header class="nginx-discovery-runtime__header">
      <div>
        <strong>{{ runtime.binaryPath }}</strong>
        <span>{{ runtime.mainConfigPath || '未识别主配置路径' }}</span>
      </div>
      <div class="nginx-discovery-runtime__badges">
        <a-tag :color="runtime.running ? 'success' : 'default'">{{ runtime.running ? '运行中' : '已安装' }}</a-tag>
        <a-tag v-if="runtime.version">{{ runtime.version }}</a-tag>
        <a-tag>{{ candidates.length }} 项</a-tag>
      </div>
    </header>

    <div class="nginx-discovery-candidates">
      <article
        v-for="candidate in visibleCandidates"
        :key="candidate.key"
        class="nginx-discovery-candidate"
        :class="{ 'is-selected': selectedKey === candidate.key, 'is-recommended': recommendedKey === candidate.key }"
      >
        <div class="nginx-discovery-candidate__content">
          <strong><GlobalOutlined />建议访问：{{ candidate.endpoint?.url || '无 TCP 访问地址' }}</strong>
          <span>listen：{{ formatListen(candidate) }}</span>
          <span>server_name：{{ formatDiscoveryServerNames(candidate.site) }}</span>
          <span><FolderOutlined />root：{{ candidate.root.path }}</span>
        </div>
        <div class="nginx-discovery-candidate__meta">
          <a-tag v-if="candidate.endpoint?.scope === 'local'" color="warning">仅服务器本机</a-tag>
          <a-tag v-if="candidate.root.hasIndexHtml" color="success">index.html</a-tag>
          <YButton
            size="small"
            :type="recommendedKey === candidate.key ? 'primary' : 'default'"
            :disabled="disabled"
            @click="selectCandidate(candidate)"
          >
            {{ selectedKey === candidate.key ? '已采用' : recommendedKey === candidate.key ? '推荐接入' : '采用' }}
          </YButton>
        </div>
      </article>
    </div>

    <YButton v-if="candidates.length > 5" type="text" size="small" @click="expanded = !expanded">
      {{ expanded ? '收起其余候选' : `展开其余 ${candidates.length - 5} 项` }}
    </YButton>
  </section>
</template>

<style scoped lang="less">
@import './runtime-group.less';
</style>
