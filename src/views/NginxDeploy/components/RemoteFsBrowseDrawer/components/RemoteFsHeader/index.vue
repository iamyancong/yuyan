<script setup lang="ts">
import { computed } from 'vue';
import {
  DownOutlined,
  FolderOpenOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons-vue';
import type { DeployServer, RemoteFsRoot } from '@/api/deploy';

defineOptions({ name: 'RemoteFsHeader' });

interface RemoteFsHeaderProps {
  server?: DeployServer | null;
  roots: RemoteFsRoot[];
  currentPath: string;
}

const props = defineProps<RemoteFsHeaderProps>();
const emit = defineEmits<{
  (e: 'selectRoot', path: string): void;
}>();

/** 计算当前路径归属的允许根 */
const activeRoot = computed(() => {
  return props.roots.find(
    (r) => props.currentPath === r.path || props.currentPath.startsWith(`${r.path}/`)
  ) || props.roots[0];
});
</script>

<template>
  <div class="remote-fs-header-compact">
    <!-- 左侧：标题与服务器状态 -->
    <div class="header-left-col">
      <div class="header-icon-box">
        <FolderOpenOutlined />
      </div>
      <div class="header-title-wrap">
        <div class="title-row">
          <span class="main-title">浏览远程目录</span>
          <div v-if="server" class="server-pill" :title="`主机: ${server.host}`">
            <span class="status-indicator"></span>
            <span class="server-title">{{ server.name }}</span>
            <code class="server-ip">{{ server.host }}</code>
          </div>
        </div>
        <span class="security-caption">安全隔离运维 · 仅可访问经授权的站点与 Nginx 配置范围</span>
      </div>
    </div>

    <!-- 右侧：紧凑型安全根作用域切换器（取代原本整行横向铺开的笨拙卡片） -->
    <div v-if="roots.length > 0" class="header-right-col">
      <a-dropdown :trigger="['click']" placement="bottomRight">
        <button type="button" class="scope-selector-btn" title="点击切换远程允许根目录">
          <SafetyCertificateOutlined class="shield-icon" />
          <span class="scope-label">作用域:</span>
          <span class="scope-current-name">{{ activeRoot?.label || '默认根' }}</span>
          <code class="scope-current-path">{{ activeRoot?.path }}</code>
          <DownOutlined class="arrow-icon" />
        </button>
        <template #overlay>
          <a-menu class="scope-dropdown-menu">
            <div class="dropdown-header-tip">切换安全根作用域</div>
            <a-menu-item
              v-for="root in roots"
              :key="root.path"
              class="scope-menu-item"
              :class="{ 'is-selected': activeRoot?.path === root.path }"
              @click="emit('selectRoot', root.path)"
            >
              <div class="menu-item-row">
                <span class="item-name">{{ root.label || '作用域根' }}</span>
                <code class="item-path">{{ root.path }}</code>
              </div>
            </a-menu-item>
          </a-menu>
        </template>
      </a-dropdown>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
