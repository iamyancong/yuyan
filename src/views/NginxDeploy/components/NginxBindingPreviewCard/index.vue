<script setup lang="ts">
import { computed } from 'vue';
import {
  ArrowRightOutlined,
  FolderOpenOutlined,
  HddOutlined,
  InfoCircleOutlined,
  LinkOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons-vue';
import type { DeployServer, NginxInstance } from '@/api/deploy';
import { resolveBindingPreviewInfo } from './constant';

defineOptions({ name: 'NginxBindingPreviewCard' });

/**
 * 绑定拓扑指示条属性
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
}

const props = defineProps<NginxBindingPreviewCardProps>();

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
  <div v-if="preview.isComplete" class="nginx-binding-preview-strip">
    <div class="strip-flow">
      <div class="flow-pill flow-pill--title">
        <LinkOutlined class="icon-link" />
        <span class="label">绑定关联</span>
      </div>

      <div class="flow-node node-server" :title="preview.serverDisplay">
        <HddOutlined class="node-icon" />
        <span class="node-name">{{ preview.serverName }}</span>
        <span v-if="preview.serverHost" class="node-sub">({{ preview.serverHost }})</span>
      </div>

      <div class="flow-connector">
        <span class="connector-line" />
        <span class="connector-badge" :class="preview.instanceType">
          {{ preview.instanceTypeLabel }}
        </span>
        <ArrowRightOutlined class="connector-arrow" />
      </div>

      <div class="flow-node node-instance" :title="preview.instanceDisplay">
        <ThunderboltOutlined class="node-icon" />
        <span class="node-name">{{ preview.instanceName }}</span>
        <span v-if="preview.instanceVersion" class="node-version">{{ preview.instanceVersion }}</span>
      </div>

      <div class="status-indicator">
        <span class="status-dot" :style="{ backgroundColor: preview.statusColor }" />
        <span class="status-text">{{ preview.statusLabel }}</span>
      </div>
    </div>

    <div class="strip-meta">
      <div class="meta-item root-dir" :title="'基准部署根目录: ' + preview.defaultRoot">
        <FolderOpenOutlined class="meta-icon" />
        <span class="meta-label">基准目录:</span>
        <code class="meta-code">{{ preview.defaultRoot }}</code>
      </div>

      <a-tooltip :title="preview.tooltipText" placement="top">
        <span class="help-trigger">
          <InfoCircleOutlined />
        </span>
      </a-tooltip>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>

