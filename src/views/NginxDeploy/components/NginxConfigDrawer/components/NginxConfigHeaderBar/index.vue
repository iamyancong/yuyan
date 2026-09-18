<script setup lang="ts">
import {
  ArrowRightOutlined,
  CheckOutlined,
  CodeOutlined,
  CopyOutlined,
  ExportOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  HddOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons-vue';
import type { DeployTarget } from '@/api/deploy';
import { useConfigHeaderBar } from './hooks/useConfigHeaderBar';

defineOptions({ name: 'NginxConfigHeaderBar' });

/** 站点配置顶栏属性 */
interface NginxConfigHeaderBarProps {
  /** 关联部署目标 */
  target?: DeployTarget | null;
  /** 当前加载的配置文件路径 */
  configPath?: string;
}

const props = defineProps<NginxConfigHeaderBarProps>();

const { meta, copied, handleCopyPath, handleOpenVisit } = useConfigHeaderBar(props);
</script>

<template>
  <header class="nginx-config-header-bar">
    <!-- 第一层：拓扑与运行态上下文条 -->
    <div class="nginx-config-header-bar__topology">
      <div class="topology-chain">
        <!-- 服务器节点 -->
        <div class="chain-node node-server" :title="`${meta.serverName} (${meta.serverHost || '无 IP'})`">
          <HddOutlined class="node-icon" />
          <span class="node-title">{{ meta.serverName }}</span>
          <span v-if="meta.serverHost" class="node-sub">({{ meta.serverHost }})</span>
        </div>

        <span class="chain-arrow">
          <ArrowRightOutlined />
        </span>

        <!-- Nginx 实例节点 -->
        <div class="chain-node node-instance" :title="`Nginx 实例: ${meta.instanceName}`">
          <ThunderboltOutlined class="node-icon node-icon--instance" />
          <span class="node-title">{{ meta.instanceName }}</span>
          <span class="instance-badge" :class="meta.instanceType">
            {{ meta.instanceTypeLabel }}
          </span>
        </div>
      </div>

      <!-- 右侧：状态指示与安全 -->
      <div class="topology-status">
        <!-- 运行状态灯 -->
        <div class="status-indicator" :title="`服务状态: ${meta.statusLabel}`">
          <span class="status-dot status-dot--online" />
          <span class="status-text">{{ meta.statusLabel }}</span>
        </div>

        <!-- SSL 证书微标 -->
        <a-tooltip :title="meta.sslTip" placement="top">
          <div class="ssl-badge">
            <SafetyCertificateOutlined class="ssl-icon" />
            <span class="ssl-text">{{ meta.sslLabel }}</span>
          </div>
        </a-tooltip>

        <!-- 访问站点快捷链接 -->
        <a-tooltip v-if="meta.visitUrl" :title="`在新窗口中打开站点: ${meta.visitUrl}`" placement="top">
          <button type="button" class="visit-action-btn" @click="handleOpenVisit">
            <ExportOutlined class="visit-icon" />
            <span>访问站点</span>
          </button>
        </a-tooltip>
      </div>
    </div>

    <!-- 第二层：代码编辑器文件与路由工具条 -->
    <div class="nginx-config-header-bar__editor-bar">
      <!-- 左侧：配置文件路径与复制 -->
      <div class="file-workspace">
        <span class="file-badge">
          <CodeOutlined class="file-icon" />
          <span class="file-badge-text">配置文件</span>
        </span>

        <a-tooltip :title="`完整路径：${meta.configPathDisplay}`" placement="topLeft">
          <div class="file-path-container">
            <span v-if="meta.configDir" class="file-path-dir">{{ meta.configDir }}</span>
            <strong class="file-path-name">{{ meta.configFileName }}</strong>
          </div>
        </a-tooltip>

        <a-tooltip :title="copied ? '复制成功！' : '复制配置文件全路径'" placement="top">
          <button
            type="button"
            :class="['copy-action-btn', { 'is-copied': copied }]"
            aria-label="复制配置文件全路径"
            @click="handleCopyPath"
          >
            <CheckOutlined v-if="copied" class="copy-icon is-success" />
            <CopyOutlined v-else class="copy-icon" />
          </button>
        </a-tooltip>
      </div>

      <!-- 右侧：目标路由映射关系 -->
      <div class="route-mapping">
        <span class="mapping-label">路由映射:</span>
        <div class="mapping-content" :title="`${meta.domainText} → ${meta.routeMapping}`">
          <span class="mapping-domain">
            <GlobalOutlined class="domain-icon" />
            {{ meta.domainText }}
          </span>
          <span class="mapping-arrow">→</span>
          <span class="mapping-dest">
            <FolderOpenOutlined class="dest-icon" />
            <code class="dest-code">{{ meta.routeMapping }}</code>
          </span>
        </div>
      </div>
    </div>
  </header>
</template>

<style scoped lang="less">
@import './style.less';
</style>
