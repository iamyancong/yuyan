<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ReloadOutlined } from '@ant-design/icons-vue';
import { YButton } from '@ycwang-dev/components/lite';
import type { NginxArchiveDownloadType, NginxArchiveSiteOption } from '@/api/deploy';
import { ARCHIVE_TYPE_OPTIONS, type ArchiveSiteSelectionModalProps } from './constant';
import {
  canSubmitArchiveSelection,
  getSelectableArchiveSites,
  normalizeArchiveSiteIds,
} from './selectionPolicy';
defineOptions({ name: 'NginxArchiveSiteSelectionModal' });
const props = defineProps<ArchiveSiteSelectionModalProps>();
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'refresh'): void;
  (e: 'confirm', value: { type: NginxArchiveDownloadType; siteIds: string[] }): void;
}>();
const selectedType = ref<NginxArchiveDownloadType>('all');
const selectedSiteIds = ref<string[]>([]);
const selectableSites = computed(() => getSelectableArchiveSites(props.sites, selectedType.value));
const canConfirm = computed(() => canSubmitArchiveSelection(selectedSiteIds.value, props.loading, props.downloading));
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    selectedType.value = props.type;
    selectedSiteIds.value = [];
  }
);
watch([selectedType, () => props.sites], () => {
  selectedSiteIds.value = normalizeArchiveSiteIds(selectedSiteIds.value, props.sites, selectedType.value);
});

/** 判断站点在当前下载类型下是否禁用。 */
const isSiteDisabled = (site: NginxArchiveSiteOption) => selectedType.value !== 'conf' && !site.canDownloadFiles;

/** 切换单个 server 的选中状态。 */
const toggleSite = (site: NginxArchiveSiteOption, checked: boolean) => {
  if (isSiteDisabled(site)) return;
  const next = new Set(selectedSiteIds.value);
  if (checked) next.add(site.id);
  else next.delete(site.id);
  selectedSiteIds.value = [...next];
};

/** 选中当前类型下全部可下载 server。 */
const selectAll = () => {
  selectedSiteIds.value = selectableSites.value.map((site) => site.id);
};

/** 清空全部选择。 */
const clearAll = () => {
  selectedSiteIds.value = [];
};

/** 提交归档选择。 */
const confirmSelection = () => {
  if (!canConfirm.value) return;
  emit('confirm', { type: selectedType.value, siteIds: selectedSiteIds.value });
};
</script>

<template>
  <a-modal
    :open="open"
    title="选择要下载的 Nginx 项目"
    width="min(820px, 94vw)"
    :mask-closable="!downloading"
    :closable="!downloading"
    :keyboard="!downloading"
    class="nginx-archive-selection-modal"
    @cancel="emit('update:open', false)"
  >
    <a-spin :spinning="loading">
      <div class="archive-selection-content">
        <div class="archive-selection-config">
          <div>
            <span>配置来源</span>
            <code>{{ configPath || '正在读取主配置…' }}</code>
          </div>
          <YButton size="small" :disabled="downloading" @click="emit('refresh')">
            <template #icon><ReloadOutlined /></template>
            刷新配置
          </YButton>
        </div>

        <a-radio-group v-model:value="selectedType" class="archive-type-options">
          <a-radio-button v-for="option in ARCHIVE_TYPE_OPTIONS" :key="option.value" :value="option.value">
            <strong>{{ option.label }}</strong>
            <span>{{ option.description }}</span>
          </a-radio-button>
        </a-radio-group>

        <div class="archive-selection-toolbar">
          <div>
            <strong>选择 server</strong>
            <span>默认不选择，避免无意下载全部项目</span>
          </div>
          <div>
            <YButton size="small" :disabled="!selectableSites.length" @click="selectAll">全选</YButton>
            <YButton size="small" :disabled="!selectedSiteIds.length" @click="clearAll">清空</YButton>
          </div>
        </div>

        <a-empty v-if="!loading && !sites.length" description="主配置中没有可选择的 server 块" />
        <div v-else class="archive-site-list">
          <label
            v-for="site in sites"
            :key="site.id"
            class="archive-site-item"
            :class="{ 'is-disabled': isSiteDisabled(site), 'is-selected': selectedSiteIds.includes(site.id) }"
          >
            <a-checkbox
              :checked="selectedSiteIds.includes(site.id)"
              :disabled="isSiteDisabled(site)"
              @change="(event: any) => toggleSite(site, Boolean(event.target?.checked))"
            />
            <div class="archive-site-main">
              <div class="archive-site-title">
                <strong>{{ site.listenPorts.length ? site.listenPorts.map((port) => `:${port}`).join('、') : '未声明端口' }}</strong>
                <a-tag v-for="name in site.projectNames" :key="name" color="purple">{{ name }}</a-tag>
                <a-tag v-if="!site.canDownloadFiles" color="orange">仅可下载配置</a-tag>
              </div>
              <div class="archive-site-meta">
                <span><b>root</b> {{ site.roots.join('、') || '未配置' }}</span>
                <span><b>server_name</b> {{ site.serverNames.join('、') || '-' }}</span>
              </div>
            </div>
          </label>
        </div>
      </div>
    </a-spin>

    <template #footer>
      <div class="archive-selection-footer">
        <span>已选择 {{ selectedSiteIds.length }} 个 server</span>
        <div>
          <YButton :disabled="downloading" @click="emit('update:open', false)">取消</YButton>
          <YButton type="primary" :loading="downloading" :disabled="!canConfirm" @click="confirmSelection">开始下载</YButton>
        </div>
      </div>
    </template>
  </a-modal>
</template>

<style scoped lang="less">
@import './style.less';
</style>
