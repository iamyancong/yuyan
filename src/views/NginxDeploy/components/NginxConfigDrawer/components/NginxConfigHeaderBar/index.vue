<script setup lang="ts">
import { computed } from 'vue';
import { GlobalOutlined } from '@ant-design/icons-vue';
import type { DeployTarget } from '@/api/deploy';
import { resolveConfigHeaderBarMeta } from './constant';

defineOptions({ name: 'NginxConfigHeaderBar' });

/**
 * 站点配置顶栏属性
 */
interface NginxConfigHeaderBarProps {
  /** 关联部署目标 */
  target?: DeployTarget | null;
  /** 当前加载的配置文件路径 */
  configPath?: string;
}

const props = defineProps<NginxConfigHeaderBarProps>();

const meta = computed(() => resolveConfigHeaderBarMeta(props.target, props.configPath));
</script>

<template>
  <div class="nginx-config-header-bar">
    <div class="nginx-config-header-bar__left">
      <GlobalOutlined />
      <span class="route-domain">{{ meta.domainText }}</span>
      <span class="route-arrow">→</span>
      <span class="route-dest">{{ meta.routeMapping }}</span>
      <a-tooltip :title="`配置文件实际路径：${meta.configPathDisplay}`">
        <a-tag color="blue" class="config-path-tag">
          {{ meta.configPathDisplay }}
        </a-tag>
      </a-tooltip>
    </div>

    <div class="nginx-config-header-bar__right">
      <span class="instance-pill">
        {{ meta.instanceText }}
      </span>
      <a-tag :color="meta.instanceTypeLabel === '托管' ? 'cyan' : 'purple'">
        {{ meta.instanceTypeLabel }}
      </a-tag>
      <span class="ssl-placeholder">SSL: — (规划中)</span>
      <a-tag color="green">已启用</a-tag>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
