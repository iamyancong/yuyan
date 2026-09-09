<script setup lang="ts">
import { computed, toRef } from 'vue';
import { YButton } from '@yss-ui/components/lite';
import type { BuildJdk, DeployServer, ServerJavaRuntime } from '@/api/deploy';
import { useBackendJavaManager } from './hooks/useBackendJavaManager';

defineOptions({ name: 'BackendJavaManagerDrawer' });

/** Java 环境管理抽屉属性 */
interface BackendJavaManagerDrawerProps {
  open: boolean;
  serverId: number;
  servers: DeployServer[];
}

const props = defineProps<BackendJavaManagerDrawerProps>();
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'update:serverId', value: number): void;
  (e: 'updated'): void;
  (e: 'selectBuildJdk', value: BuildJdk): void;
  (e: 'selectRuntime', value: ServerJavaRuntime): void;
}>();

const drawerOpen = computed({ get: () => props.open, set: (value: boolean) => emit('update:open', value) });
const activeServerId = computed({ get: () => props.serverId, set: (value: number) => emit('update:serverId', value) });
const state = useBackendJavaManager({
  open: toRef(props, 'open'),
  serverId: toRef(props, 'serverId'),
  onUpdated: () => emit('updated'),
});

/** Java 状态颜色 */
const getStatusColor = (status: string) => status === 'available' ? 'success' : status === 'unavailable' ? 'error' : 'default';

/**
 * 格式化 JDK 架构名称。
 * @param arch 数据库存储的架构
 * @returns 用户可读架构
 */
const getArchitectureLabel = (arch: string) => {
  if (arch === 'arm64') return 'ARM64';
  if (arch === 'x64') return 'x64';
  if (arch === 'x86') return 'x86';
  return arch || '架构待检测';
};
</script>

<template>
  <a-drawer v-model:open="drawerOpen" width="min(92vw, 980px)" title="Java 环境管理" destroyOnClose>
    <a-spin :spinning="state.loading.value">
      <a-tabs>
        <a-tab-pane key="local" tab="本机构建 JDK">
          <a-alert
            type="info"
            show-icon
            message="构建 JDK 只需能在本机运行，不要求与服务器 CPU 架构一致；Jar 上传后由服务器自己的运行 JDK 启动。平台只检测，不会切换系统默认 Java。"
          />
          <div class="java-server-toolbar">
            <span>从 SDKMAN、jEnv、macOS JDK 目录发现已安装版本</span>
            <YButton :loading="state.actionKey.value === 'scan-local'" @click="state.scanLocalJdks(false)">扫描本机 JDK</YButton>
          </div>
          <div class="java-add-row">
            <a-input v-model:value="state.localForm.name" placeholder="名称，例如 Temurin 8" />
            <a-input v-model:value="state.localForm.homePath" placeholder="本机 JAVA_HOME 绝对路径" />
            <YButton type="primary" :loading="state.actionKey.value === 'add-local'" @click="state.addLocalJdk">新增并检测</YButton>
          </div>
          <div v-for="jdk in state.localJdks.value" :key="jdk.id" class="java-runtime-row">
            <div class="java-runtime-row__main">
              <strong>{{ jdk.name }}</strong>
              <span>{{ jdk.homePath }}</span>
              <small>{{ jdk.javaVersion || jdk.statusOutput || '尚未检测' }}</small>
            </div>
            <a-tag :color="getStatusColor(jdk.status)">
              {{ jdk.status === 'available' ? `Java ${jdk.majorVersion} · ${getArchitectureLabel(jdk.arch)}` : jdk.status }}
            </a-tag>
            <a-space>
              <YButton type="link" :loading="state.actionKey.value === `local-${jdk.id}`" @click="state.testLocalJdk(jdk)">检测</YButton>
              <YButton type="link" :disabled="jdk.status !== 'available'" @click="emit('selectBuildJdk', jdk)">使用</YButton>
              <a-popconfirm title="确认删除该 JDK 配置？" ok-text="删除" cancel-text="取消" @confirm="state.deleteLocalJdk(jdk)">
                <YButton type="link" danger>删除</YButton>
              </a-popconfirm>
            </a-space>
          </div>
          <a-empty v-if="!state.localJdks.value.length" description="尚未配置真实 JDK；系统不会创建不存在的占位路径" />
        </a-tab-pane>
        <a-tab-pane key="server" tab="服务器运行 JDK">
          <a-alert
            type="info"
            show-icon
            message="运行 JDK 位于目标服务器，必须能在服务器自身架构上执行；它可与本机构建 JDK 架构不同，但 Java 主版本和编译目标必须兼容。"
          />
          <div class="java-server-toolbar">
            <a-select v-model:value="activeServerId" placeholder="选择服务器" style="min-width: 260px">
              <a-select-option v-for="server in servers" :key="server.id" :value="server.id">{{ server.name }}（{{ server.host }}）</a-select-option>
            </a-select>
            <YButton :disabled="!activeServerId" :loading="state.actionKey.value === 'scan-server'" @click="state.scanServerRuntimes">扫描常见路径</YButton>
          </div>
          <div class="java-add-row">
            <a-input v-model:value="state.serverForm.name" placeholder="名称，例如 Server JDK 8" />
            <a-input v-model:value="state.serverForm.homePath" placeholder="服务器 JAVA_HOME 绝对路径" />
            <YButton type="primary" :disabled="!activeServerId" :loading="state.actionKey.value === 'add-server'" @click="state.addServerRuntime">新增并检测</YButton>
          </div>
          <div v-for="runtime in state.serverRuntimes.value" :key="runtime.id" class="java-runtime-row">
            <div class="java-runtime-row__main">
              <strong>{{ runtime.name }}</strong>
              <span>{{ runtime.homePath }}</span>
              <small>{{ runtime.javaVersion || runtime.statusOutput || '尚未检测' }}</small>
            </div>
            <a-tag :color="getStatusColor(runtime.status)">
              {{ runtime.status === 'available' ? `Java ${runtime.majorVersion} · ${getArchitectureLabel(runtime.arch)}` : runtime.status }}
            </a-tag>
            <a-space>
              <YButton type="link" :loading="state.actionKey.value === `server-${runtime.id}`" @click="state.testServerRuntime(runtime)">检测</YButton>
              <YButton type="link" :disabled="runtime.status !== 'available'" @click="emit('selectRuntime', runtime)">使用</YButton>
              <a-popconfirm
                title="确认删除该服务器 JDK 配置？"
                description="被部署目标引用的运行时无法删除。"
                ok-text="删除"
                cancel-text="取消"
                @confirm="state.deleteServerRuntime(runtime)"
              >
                <YButton type="link" danger :loading="state.actionKey.value === `delete-server-${runtime.id}`">删除</YButton>
              </a-popconfirm>
            </a-space>
          </div>
          <a-empty v-if="!state.serverRuntimes.value.length" description="未检测到服务器 Java 运行时" />
        </a-tab-pane>
      </a-tabs>
    </a-spin>
  </a-drawer>
</template>

<style scoped lang="less">
@import './style.less';
</style>
