<script setup lang="ts">
import message from 'ant-design-vue/es/message';
import { YButton } from '@ycwang-dev/components/lite';
import { copyToClipboard } from '@ycwang-dev/utils';
import { CloudDownloadOutlined, CopyOutlined, DownOutlined } from '@ant-design/icons-vue';
import type { RuntimePathRow } from './constant';

defineOptions({ name: 'NginxRuntimePathPreview' });

/** Nginx 路径预览属性 */
interface RuntimePathPreviewProps {
  isManagedInstance: boolean;
  title: string;
  tip: string;
  rows: RuntimePathRow[];
  canDownloadArchive: boolean;
  archiveDownloading: boolean;
}

defineProps<RuntimePathPreviewProps>();

const emit = defineEmits<{
  (e: 'downloadArchive', type: 'all' | 'html' | 'conf'): void;
}>();

/**
 * 复制路径值。
 * @param value 待复制路径
 */
const copyPath = async (value?: string) => {
  const text = String(value || '').trim();
  if (!text || text === '-') {
    message.warning('暂无可复制的路径');
    return;
  }
  const copied = await copyToClipboard(text);
  if (copied) {
    message.success('路径已复制到剪贴板');
    return;
  }
  message.error('路径复制失败');
};
</script>

<template>
  <section class="nginx-runtime-card nginx-runtime-path-card">
    <div class="nginx-runtime-section-title">
      <div class="nginx-runtime-section-title__left">
        <strong>{{ title }}</strong>
        <span>{{ tip }}</span>
      </div>
      <div v-if="isManagedInstance" class="nginx-runtime-download-group">
        <YButton class="nginx-runtime-download-btn" :disabled="!canDownloadArchive" :loading="archiveDownloading" @click="emit('downloadArchive', 'all')">
          <template #icon><CloudDownloadOutlined /></template>
          下载运行包
        </YButton>
        <a-dropdown :disabled="!canDownloadArchive" placement="bottomRight">
          <YButton class="nginx-runtime-download-arrow" :disabled="!canDownloadArchive">
            <template #icon><DownOutlined /></template>
          </YButton>
          <template #overlay>
            <a-menu @click="(e: any) => emit('downloadArchive', e.key)">
              <a-menu-item key="all">📦 完整运行包 (tar.gz)</a-menu-item>
              <a-menu-item key="html">🌐 仅前端静态产物 (tar.gz)</a-menu-item>
              <a-menu-item key="conf">⚙️ 仅 Nginx 配置文件 (nginx.conf)</a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
      </div>
    </div>

    <div class="nginx-runtime-paths">
      <div v-for="item in rows" :key="item.label" class="nginx-runtime-path-row">
        <span>{{ item.label }}</span>
        <a-tooltip :title="item.value || '-'">
          <code>{{ item.value || '-' }}</code>
        </a-tooltip>
        <a-tooltip title="复制路径">
          <YButton size="small" shape="circle" class="nginx-runtime-copy-btn" :disabled="!item.value" @click="copyPath(item.value)">
            <template #icon><CopyOutlined /></template>
          </YButton>
        </a-tooltip>
      </div>
    </div>
  </section>
</template>
