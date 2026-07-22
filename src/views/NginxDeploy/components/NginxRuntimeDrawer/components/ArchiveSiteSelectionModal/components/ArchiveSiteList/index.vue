<script setup lang="ts">
import { CheckOutlined, FolderOutlined, GlobalOutlined } from '@ant-design/icons-vue';
import { computed } from 'vue';
import type { NginxArchiveDownloadType, NginxArchiveSiteOption } from '@/api/deploy';

defineOptions({ name: 'NginxArchiveSiteList' });

/** server 项目列表属性。 */
interface ArchiveSiteListProps {
  sites: NginxArchiveSiteOption[];
  selectedIds: string[];
  type: NginxArchiveDownloadType;
  loading: boolean;
}

const props = defineProps<ArchiveSiteListProps>();

const emit = defineEmits<{
  (e: 'update:selectedIds', value: string[]): void;
}>();

const selectedIdSet = computed(() => new Set(props.selectedIds));

/** 判断当前归档类型下的站点是否不可下载。 */
const isSiteDisabled = (site: NginxArchiveSiteOption) => props.type !== 'conf' && !site.canDownloadFiles;

/** 切换单个 server 的选择状态。 */
const toggleSite = (site: NginxArchiveSiteOption) => {
  if (isSiteDisabled(site)) return;
  const next = new Set(props.selectedIds);
  if (next.has(site.id)) next.delete(site.id);
  else next.add(site.id);
  emit('update:selectedIds', [...next]);
};

/** 格式化 server 监听端口。 */
const formatListenPorts = (site: NginxArchiveSiteOption) => (
  site.listenPorts.length ? site.listenPorts.map((port) => `:${port}`).join(' · ') : '未声明端口'
);
</script>

<template>
  <a-empty v-if="!loading && !sites.length" description="主配置中没有可选择的 server 块" />
  <div v-else class="archive-site-list" aria-label="可下载的 Nginx server 列表">
    <button
      v-for="(site, index) in sites"
      :key="site.id"
      type="button"
      class="archive-site-card"
      :class="{
        'is-disabled': isSiteDisabled(site),
        'is-selected': selectedIdSet.has(site.id),
      }"
      :disabled="isSiteDisabled(site)"
      :aria-pressed="selectedIdSet.has(site.id)"
      @click="toggleSite(site)"
    >
      <span class="archive-site-card__rail">
        <span class="archive-site-card__order">{{ String(index + 1).padStart(2, '0') }}</span>
        <span class="archive-site-card__check"><CheckOutlined v-if="selectedIdSet.has(site.id)" /></span>
      </span>

      <span class="archive-site-card__body">
        <span class="archive-site-card__title-row">
          <strong>{{ formatListenPorts(site) }}</strong>
          <span v-for="name in site.projectNames" :key="name" class="archive-site-card__project">{{ name }}</span>
          <span v-if="!site.canDownloadFiles" class="archive-site-card__warning">仅配置</span>
        </span>

        <span class="archive-site-card__meta">
          <span><FolderOutlined /><b>项目根目录</b><code>{{ site.roots.join('、') || '未配置' }}</code></span>
          <span><GlobalOutlined /><b>访问域名</b><code>{{ site.serverNames.join('、') || '-' }}</code></span>
        </span>
      </span>

      <span class="archive-site-card__state">{{ selectedIdSet.has(site.id) ? '已选择' : '选择' }}</span>
    </button>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
