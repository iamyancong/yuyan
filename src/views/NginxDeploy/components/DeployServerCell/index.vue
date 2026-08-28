<script setup lang="ts">
import { getServerSubtitle, getServerTitle } from './constant';

defineOptions({ name: 'DeployServerCell' });

/** 服务器单元格属性 */
interface DeployServerCellProps {
  /** 服务器名称 */
  serverName?: string | null;
  /** 服务器 IP / 域名 */
  serverHost?: string | null;
}

const props = defineProps<DeployServerCellProps>();
</script>

<template>
  <div class="deploy-server-cell">
    <a-tooltip :title="getServerTitle(props.serverName, props.serverHost)">
      <span class="deploy-server-cell__name">{{ getServerTitle(props.serverName, props.serverHost) }}</span>
    </a-tooltip>
    <a-tooltip v-if="getServerSubtitle(props.serverName, props.serverHost)" :title="getServerSubtitle(props.serverName, props.serverHost)">
      <span class="deploy-server-cell__host">{{ getServerSubtitle(props.serverName, props.serverHost) }}</span>
    </a-tooltip>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
