<script setup lang="ts">
import { computed } from 'vue';
import { DiffOutlined, DownloadOutlined, HistoryOutlined, ReloadOutlined } from '@ant-design/icons-vue';
import type { NginxConfHistoryItem } from '@/api/deploy';
import {
  formatBeijingTime,
  formatFileSize,
  formatRelativeTime,
  resolveHistoryItemTime,
} from '../../historyPolicy';

defineOptions({ name: 'NginxHistoryPopover' });

/** 历史版本弹出列表属性 */
interface Props {
  /** 是否展开 */
  open: boolean;
  /** 历史条目 */
  items: NginxConfHistoryItem[];
  /** 列表加载中 */
  loading: boolean;
  /** 是否已加载过（用于区分「加载中」与「空」） */
  loaded: boolean;
  /** 列表加载失败信息 */
  error: string;
  /** 平台备份保留份数 */
  keep: number;
  /** 列表被截断 */
  truncated: boolean;
  /** 当前正在对比的条目 */
  activeName?: string;
  /** 正在下载的条目 */
  downloadingName?: string;
  /** 整体禁用（例如配置未加载完） */
  disabled?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'refresh'): void;
  (e: 'compare', item: NginxConfHistoryItem): void;
  (e: 'download', item: NginxConfHistoryItem): void;
}>();

/** 按钮上的数量（未加载时不显示） */
const countLabel = computed(() => (props.loaded ? ` (${props.items.length})` : ''));

/** 每行展示数据 */
const rows = computed(() => {
  const now = Date.now();
  return props.items.map((item) => {
    const time = resolveHistoryItemTime(item);
    return {
      item,
      time: formatBeijingTime(time) || '时间未知',
      relative: formatRelativeTime(time, now),
      size: formatFileSize(item.size),
    };
  });
});

/** 切换展开 */
const handleOpenChange = (value: boolean) => {
  if (props.disabled && value) return;
  emit('update:open', value);
  if (value) emit('refresh');
};
</script>

<template>
  <a-popover
    :open="open"
    trigger="click"
    placement="bottomRight"
    overlay-class-name="nginx-history-popover-overlay"
    @open-change="handleOpenChange"
  >
    <template #content>
      <div class="nginx-history-panel">
        <div class="history-panel-header">
          <span class="history-panel-title">历史版本</span>
          <a-button size="small" type="text" :loading="loading" class="history-refresh-btn" @click="emit('refresh')">
            <template #icon><ReloadOutlined /></template>
            刷新
          </a-button>
        </div>

        <a-spin :spinning="loading && loaded">
          <div v-if="error" class="history-state history-state--error">{{ error }}</div>
          <div v-else-if="!loaded" class="history-state">正在读取服务器上的备份…</div>
          <div v-else-if="rows.length === 0" class="history-state history-state--empty">
            <HistoryOutlined class="empty-icon" />
            <div class="empty-title">该文件还没有平台备份</div>
            <div class="empty-desc">在这里保存一次配置后，服务器会自动生成备份</div>
          </div>
          <ul v-else class="history-list">
            <li
              v-for="row in rows"
              :key="row.item.name"
              :class="['history-row', { 'is-active': row.item.name === activeName }]"
            >
              <div class="history-row-main">
                <div class="history-row-time">
                  <span class="time-text">{{ row.time }}</span>
                  <span v-if="row.relative" class="time-relative">{{ row.relative }}</span>
                </div>
                <div class="history-row-meta">
                  <span class="meta-size">{{ row.size }}</span>
                  <a-tag v-if="row.item.source === 'external'" class="history-tag history-tag--external" :title="row.item.name">外部</a-tag>
                  <a-tag v-else class="history-tag history-tag--replaced">被替换前版本</a-tag>
                  <span v-if="row.item.source === 'external'" class="meta-name" :title="row.item.name">{{ row.item.name }}</span>
                </div>
              </div>
              <div class="history-row-actions">
                <a-button size="small" type="primary" ghost @click="emit('compare', row.item)">
                  <template #icon><DiffOutlined /></template>
                  对比
                </a-button>
                <a-tooltip title="下载此版本" placement="top">
                  <a-button size="small" :loading="downloadingName === row.item.name" @click="emit('download', row.item)">
                    <template #icon><DownloadOutlined /></template>
                  </a-button>
                </a-tooltip>
              </div>
            </li>
          </ul>
        </a-spin>

        <div class="history-panel-footer">
          时间为北京时间；每次保存会把被替换前的内容备份到服务器同目录，平台备份保留最近 {{ keep }} 份<span v-if="truncated">（仅显示最近 200 条）</span>
        </div>
      </div>
    </template>
    <button
      type="button"
      :class="['history-trigger-btn', { 'is-open': open }]"
      :disabled="disabled"
      aria-label="查看历史版本"
    >
      <HistoryOutlined />
      <span>历史版本{{ countLabel }}</span>
    </button>
  </a-popover>
</template>

<style scoped lang="less">
@import './style.less';
</style>
