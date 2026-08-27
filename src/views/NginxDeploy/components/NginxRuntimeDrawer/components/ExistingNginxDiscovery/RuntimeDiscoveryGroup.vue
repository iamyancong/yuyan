<script setup lang="ts">
import { CheckOutlined, FolderOutlined, GlobalOutlined } from '@ant-design/icons-vue';
import type { NginxDiscoveryRoot, NginxDiscoveryRuntime, NginxDiscoverySite } from '@/api/deploy';
import { createExistingNginxSelection, getPreferredDiscoveryRoot, type ExistingNginxSelection } from './selectionPolicy';

defineOptions({ name: 'NginxRuntimeDiscoveryGroup' });

/** 单个物理 Nginx 发现分组属性。 */
interface RuntimeDiscoveryGroupProps {
  runtime: NginxDiscoveryRuntime;
  selectedKey: string;
}

const props = defineProps<RuntimeDiscoveryGroupProps>();
const emit = defineEmits<{ select: [value: ExistingNginxSelection] }>();

/** 站点类型中文标签。 */
const SITE_TYPE_LABELS: Record<NginxDiscoverySite['type'], string> = {
  static: '静态站点',
  mixed: '静态 + 代理',
  proxy: '纯反向代理',
  unknown: '无法自动判断',
};

/** 格式化监听端口。 */
const formatListen = (site: NginxDiscoverySite) => site.listenValues.join(' · ') || ':80';

/** 格式化 server_name。 */
const formatServerNames = (site: NginxDiscoverySite) => site.serverNames.join('、') || '_';

/** 选择一个明确的前端根目录。 */
const selectRoot = (site: NginxDiscoverySite, root: NginxDiscoveryRoot) => {
  if (props.runtime.connectedInstanceId) return;
  emit('select', createExistingNginxSelection(props.runtime, site, root));
};

/** 单 root 站点允许点击摘要直接选择。 */
const selectSingleRootSite = (site: NginxDiscoverySite) => {
  if (site.roots.length !== 1) return;
  const root = getPreferredDiscoveryRoot(site);
  if (root) selectRoot(site, root);
};

/** 判断 root 是否已选择。 */
const isRootSelected = (site: NginxDiscoverySite, root: NginxDiscoveryRoot) => (
  props.selectedKey === `${props.runtime.id}:${site.id}:${root.path}`
);
</script>

<template>
  <section class="nginx-discovery-runtime" :class="{ 'is-connected': runtime.connectedInstanceId }">
    <header class="nginx-discovery-runtime__header">
      <div><strong>{{ runtime.binaryPath }}</strong><span>{{ runtime.mainConfigPath || '未识别主配置路径' }}</span></div>
      <div class="nginx-discovery-runtime__badges">
        <a-tag :color="runtime.running ? 'success' : 'default'">{{ runtime.running ? '运行中' : '已安装' }}</a-tag>
        <a-tag v-if="runtime.version">{{ runtime.version }}</a-tag>
        <a-tag v-if="runtime.connectedInstanceId" color="processing">已接入</a-tag>
      </div>
    </header>

    <a-alert v-if="runtime.connectedInstanceId" type="info" show-icon message="该物理 Nginx 已接入，请从左侧实例列表进入编辑，避免重复登记。" />
    <a-alert v-for="warning in runtime.warnings" :key="warning" type="warning" show-icon :message="warning" />

    <div v-if="runtime.sites.length" class="nginx-discovery-sites">
      <article v-for="site in runtime.sites" :key="site.id" class="nginx-discovery-site">
        <button
          type="button"
          class="nginx-discovery-site__summary"
          :disabled="Boolean(runtime.connectedInstanceId) || site.roots.length !== 1"
          @click="selectSingleRootSite(site)"
        >
          <span class="nginx-discovery-site__headline"><strong>{{ formatListen(site) }}</strong><em>{{ SITE_TYPE_LABELS[site.type] }}</em></span>
          <span><GlobalOutlined />{{ formatServerNames(site) }}</span>
          <span><FolderOutlined />{{ site.configPath || runtime.mainConfigPath }}</span>
        </button>

        <div v-if="site.roots.length" class="nginx-discovery-roots">
          <button
            v-for="root in site.roots"
            :key="root.path"
            type="button"
            :class="{ 'is-selected': isRootSelected(site, root) }"
            :disabled="Boolean(runtime.connectedInstanceId)"
            @click="selectRoot(site, root)"
          >
            <CheckOutlined v-if="isRootSelected(site, root)" />
            <FolderOutlined v-else />
            <code>{{ root.path }}</code>
            <small>{{ root.hasIndexHtml ? '检测到 index.html' : root.exists ? '目录存在' : '暂不可读取' }}</small>
          </button>
        </div>
        <p v-else class="nginx-discovery-site__unsupported">
          {{ site.dynamicRoots.length ? `root 含变量：${site.dynamicRoots.join('、')}` : site.aliases.length ? `仅检测到 alias：${site.aliases.join('、')}` : '未检测到静态 root，可手动填写或跳过该代理站点' }}
        </p>
      </article>
    </div>
    <a-empty v-else description="该运行实例没有可选择的 server 站点" />
  </section>
</template>

<style scoped lang="less">
@import './runtime-group.less';
</style>
