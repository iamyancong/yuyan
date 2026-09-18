<script setup lang="ts">
import { FolderOutlined, GlobalOutlined } from '@ant-design/icons-vue';
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
  <div v-else class="archive-site-list" role="listbox" aria-label="可下载的 Nginx server 列表">
    <div
      v-for="site in sites"
      :key="site.id"
      role="option"
      class="archive-site-row"
      :class="{
        'is-disabled': isSiteDisabled(site),
        'is-selected': selectedIdSet.has(site.id),
      }"
      :aria-selected="selectedIdSet.has(site.id)"
      :aria-disabled="isSiteDisabled(site)"
      tabindex="0"
      @click="toggleSite(site)"
      @keydown.space.prevent="toggleSite(site)"
      @keydown.enter.prevent="toggleSite(site)"
    >
      <div class="archive-site-row__checkbox">
        <span
          class="checkbox-inner"
          :class="{
            'is-checked': selectedIdSet.has(site.id),
            'is-disabled': isSiteDisabled(site),
          }"
        />
      </div>

      <div class="archive-site-row__body">
        <div class="archive-site-row__header">
          <div class="archive-site-row__primary">
            <span class="archive-site-row__ports">{{ formatListenPorts(site) }}</span>
            <span v-for="name in site.projectNames" :key="name" class="archive-site-row__project-tag">
              {{ name }}
            </span>
          </div>
          <div class="archive-site-row__status">
            <span v-if="!site.canDownloadFiles" class="archive-site-row__warning-tag">
              仅配置
            </span>
          </div>
        </div>

        <div class="archive-site-row__secondary">
          <span class="archive-site-row__meta-item archive-site-row__meta-item--left" :title="site.roots.join('、') || '未配置'">
            <FolderOutlined class="meta-icon" />
            <span class="meta-label">根目录:</span>
            <span class="meta-value">{{ site.roots.join('、') || '未配置' }}</span>
          </span>
          <span class="archive-site-row__meta-item archive-site-row__meta-item--right" :title="site.serverNames.join('、') || '-'">
            <GlobalOutlined class="meta-icon" />
            <span class="meta-label">域名:</span>
            <span class="meta-value">{{ site.serverNames.join('、') || '-' }}</span>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
