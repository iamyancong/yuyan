<script setup lang="ts">
import {
  CloudDownloadOutlined,
  CodeOutlined,
  DownloadOutlined,
  ReloadOutlined,
} from '@ant-design/icons-vue';
import { YButton } from '@yss-ui/components/lite';
import ArchiveSiteList from './components/ArchiveSiteList/index.vue';
import ArchiveTypeSelector from './components/ArchiveTypeSelector/index.vue';
import type { ArchiveSiteSelectionModalProps } from './constant';
import { useArchiveSelection } from './hooks/useArchiveSelection';

defineOptions({ name: 'NginxArchiveSiteSelectionModal' });

const props = defineProps<ArchiveSiteSelectionModalProps>();
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'refresh'): void;
  (e: 'confirm', value: { type: 'all' | 'html' | 'conf'; siteIds: string[] }): void;
}>();

const {
  canConfirm,
  clearAll,
  confirmSelection,
  selectableSites,
  selectedArchiveOption,
  selectedSiteIds,
  selectedType,
  selectAll,
  updateSelectedSiteIds,
} = useArchiveSelection(props, emit);
</script>

<template>
  <a-modal
    :open="open"
    width="min(920px, 94vw)"
    wrap-class-name="nginx-archive-selection-modal-root"
    class="nginx-archive-selection-modal"
    :mask-closable="!downloading"
    :closable="!downloading"
    :keyboard="!downloading"
    :destroy-on-close="false"
    @cancel="emit('update:open', false)"
  >
    <template #title>
      <div class="archive-modal-title">
        <span class="archive-modal-title__icon"><CloudDownloadOutlined /></span>
        <span class="archive-modal-title__copy">
          <strong>选择要下载的 Nginx 项目</strong>
          <small>从在线配置中精准裁剪，只带走这次需要的 server</small>
        </span>
        <span class="archive-modal-title__status"><i />安全打包</span>
      </div>
    </template>

    <a-spin :spinning="loading">
      <div class="archive-selection-content">
        <div class="archive-source-bar">
          <span class="archive-source-bar__icon"><CodeOutlined /></span>
          <span class="archive-source-bar__copy">
            <small>NGINX CONFIG SOURCE</small>
            <code :title="configPath">{{ configPath || '正在读取主配置…' }}</code>
          </span>
          <YButton size="small" :disabled="downloading" @click="emit('refresh')">
            <template #icon><ReloadOutlined /></template>
            刷新配置
          </YButton>
        </div>

        <section class="archive-selection-section">
          <div class="archive-section-heading">
            <span class="archive-section-heading__index">01</span>
            <span class="archive-section-heading__copy">
              <strong>选择交付内容</strong>
              <small>选择运行级整包，或只下载本次需要的部分</small>
            </span>
          </div>
          <ArchiveTypeSelector v-model="selectedType" :disabled="downloading" />
        </section>

        <section class="archive-selection-section archive-selection-section--sites">
          <div class="archive-section-heading archive-section-heading--with-actions">
            <span class="archive-section-heading__index">02</span>
            <span class="archive-section-heading__copy">
              <strong>选择 server</strong>
              <small>整卡点击即可选择，默认留空以避免误下载全部项目</small>
            </span>
            <span class="archive-selection-count">{{ selectedSiteIds.length }} / {{ selectableSites.length }} 已选择</span>
            <span class="archive-selection-actions">
              <YButton size="small" :disabled="!selectableSites.length" @click="selectAll">全选</YButton>
              <YButton size="small" :disabled="!selectedSiteIds.length" @click="clearAll">清空</YButton>
            </span>
          </div>

          <ArchiveSiteList
            :sites="sites"
            :selected-ids="selectedSiteIds"
            :type="selectedType"
            :loading="loading"
            @update:selected-ids="updateSelectedSiteIds"
          />
        </section>
      </div>
    </a-spin>

    <template #footer>
      <div class="archive-selection-footer">
        <span class="archive-selection-summary">
          <small>READY TO EXPORT</small>
          <strong>{{ selectedArchiveOption.label }} · {{ selectedSiteIds.length }} 个 server</strong>
        </span>
        <span class="archive-selection-footer__actions">
          <YButton :disabled="downloading" @click="emit('update:open', false)">取消</YButton>
          <YButton type="primary" :loading="downloading" :disabled="!canConfirm" @click="confirmSelection">
            <template #icon><DownloadOutlined /></template>
            开始下载
          </YButton>
        </span>
      </div>
    </template>
  </a-modal>
</template>

<style scoped lang="less">
@import './style.less';
</style>
