<script setup lang="ts">
import { computed } from 'vue';
import { ApiOutlined, InfoCircleOutlined } from '@ant-design/icons-vue';
import type { DeployServer, NginxInstance } from '@/api/deploy';
import { resolveBindingPreviewInfo } from './constant';

defineOptions({ name: 'NginxBindingPreviewCard' });

/**
 * 绑定预览卡片组件属性
 */
interface NginxBindingPreviewCardProps {
  /** 关联服务器 */
  server?: DeployServer | null;
  /** 关联 Nginx 实例 */
  instance?: NginxInstance | null;
  /** 站点域名 */
  domain?: string;
  /** 监听端口 */
  port?: number | string;
  /** 部署根目录 */
  deployRoot?: string;
  /** 底部提示文案 */
  hint?: string;
}

const props = withDefaults(defineProps<NginxBindingPreviewCardProps>(), {
  hint: '保存后将通过该 Nginx 实例管理此站点的静态代理与配置文件',
});

const preview = computed(() =>
  resolveBindingPreviewInfo(
    props.server,
    props.instance,
    props.domain,
    props.port,
    props.deployRoot
  )
);
</script>

<template>
  <div v-if="preview.isComplete" class="nginx-binding-preview-card">
    <div class="nginx-binding-preview-card__header">
      <span class="header-title">
        <ApiOutlined />
        绑定预览
      </span>
      <div class="header-extra">
        <a-tag :color="preview.instanceTypeColor">
          {{ preview.instanceTypeLabel }}
        </a-tag>
        <span class="status-indicator">
          <span class="status-dot" :style="{ backgroundColor: preview.statusColor }" />
          {{ preview.statusLabel }}
        </span>
      </div>
    </div>

    <div class="nginx-binding-preview-card__grid">
      <div class="nginx-binding-preview-card__item">
        <span class="item-label">目标服务器：</span>
        <span class="item-value">{{ preview.serverDisplay }}</span>
      </div>

      <div class="nginx-binding-preview-card__item">
        <span class="item-label">Nginx 实例：</span>
        <span class="item-value">{{ preview.instanceDisplay }}</span>
      </div>

      <div class="nginx-binding-preview-card__item">
        <span class="item-label">默认根目录：</span>
        <span class="item-value code">{{ preview.defaultRoot }}</span>
      </div>

      <div class="nginx-binding-preview-card__item">
        <span class="item-label">站点映射：</span>
        <span class="item-value code">{{ preview.routeSummary }}</span>
      </div>
    </div>

    <div v-if="hint" class="nginx-binding-preview-card__hint">
      <InfoCircleOutlined />
      <span>{{ hint }}</span>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
