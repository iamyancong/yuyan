<script setup lang="ts">
import {
  DownloadOutlined,
  FileTextOutlined,
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
    width="min(760px, 94vw)"
    wrap-class-name="nginx-archive-selection-modal-root"
    class="nginx-archive-selection-modal"
    :mask-closable="!downloading"
    :closable="!downloading"
    :keyboard="!downloading"
    :destroy-on-close="false"
    @cancel="emit('update:open', false)"
  >
    <template #title>
      <div class="archive-modal-header">
        <div class="archive-modal-header__main">
          <span class="archive-modal-header__title">
            {{ isManagedInstance !== false ? '选择要下载的 Nginx 项目' : '选择要导出的 Nginx 项目 / 站点' }}
          </span>
        </div>
        <div class="archive-modal-header__env">
          <span class="archive-modal-header__env-label">
            <FileTextOutlined /> 配置文件:
          </span>
          <code class="archive-modal-header__env-path" :title="configPath">
            {{ configPath || '正在读取主配置…' }}
          </code>
          <button
            type="button"
            class="archive-modal-header__refresh-btn"
            :disabled="downloading"
            title="刷新主配置"
            @click="emit('refresh')"
          >
            <ReloadOutlined />
            <span>刷新</span>
          </button>
        </div>
      </div>
    </template>

    <a-spin :spinning="loading">
      <div class="archive-selection-content">
        <!-- 步骤流水线 -->
        <div class="archive-step-flow">
          <!-- 步骤 1：交付内容 -->
          <div class="archive-step-item">
            <div class="archive-step-item__header">
              <span class="archive-step-item__badge">1</span>
              <span class="archive-step-item__title">选择交付内容</span>
              <span class="archive-step-item__hint">决定导出哪些维度的资源与配置</span>
            </div>
            <div class="archive-step-item__content">
              <ArchiveTypeSelector
                v-model="selectedType"
                :disabled="downloading"
                :is-managed-instance="isManagedInstance"
              />
            </div>
          </div>

          <!-- 步骤 2：选择 server 站点 -->
          <div class="archive-step-item archive-step-item--last">
            <div class="archive-step-item__header archive-step-item__header--between">
              <div class="archive-step-item__title-group">
                <span class="archive-step-item__badge">2</span>
                <span class="archive-step-item__title">勾选目标 server</span>
                <span class="archive-step-item__count">
                  已选 {{ selectedSiteIds.length }} / 共 {{ selectableSites.length }}
                </span>
              </div>
              <div class="archive-step-item__actions">
                <YButton size="small" :disabled="!selectableSites.length" @click="selectAll">全选</YButton>
                <YButton size="small" :disabled="!selectedSiteIds.length" @click="clearAll">清空</YButton>
              </div>
            </div>

            <div class="archive-step-item__content">
              <ArchiveSiteList
                :sites="sites"
                :selected-ids="selectedSiteIds"
                :type="selectedType"
                :loading="loading"
                @update:selected-ids="updateSelectedSiteIds"
              />
            </div>
          </div>
        </div>
      </div>
    </a-spin>

    <template #footer>
      <div class="archive-selection-footer">
        <div class="archive-selection-summary">
          <span class="archive-selection-summary__text">
            已选择 <strong>{{ selectedSiteIds.length }}</strong> 个 server · {{ selectedArchiveOption.label }}
          </span>
        </div>
        <div class="archive-selection-footer__actions">
          <YButton :disabled="downloading" @click="emit('update:open', false)">取消</YButton>
          <YButton type="primary" :loading="downloading" :disabled="!canConfirm" @click="confirmSelection">
            <template #icon><DownloadOutlined /></template>
            {{ isManagedInstance !== false ? '开始下载' : '开始导出' }}
          </YButton>
        </div>
      </div>
    </template>
  </a-modal>
</template>

<style scoped lang="less">
@import './style.less';
</style>
