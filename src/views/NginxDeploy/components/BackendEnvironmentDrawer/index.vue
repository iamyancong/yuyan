<script setup lang="ts">
import { computed, toRef } from 'vue';
import { PlusOutlined } from '@ant-design/icons-vue';
import { YButton } from '@yss-ui/components/lite';
import type { DeployEnvironment } from '@/api/deploy';
import EnvironmentCard from './components/EnvironmentCard/index.vue';
import { useBackendEnvironments } from './hooks/useBackendEnvironments';

defineOptions({ name: 'BackendEnvironmentDrawer' });

const props = withDefaults(defineProps<{ open: boolean; selectedEnvironmentId?: number }>(), {
  selectedEnvironmentId: 0,
});
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'updated'): void;
  (e: 'select', value: DeployEnvironment): void;
}>();

const drawerOpen = computed({ get: () => props.open, set: (value: boolean) => emit('update:open', value) });
const state = useBackendEnvironments({
  open: toRef(props, 'open'),
  selectedEnvironmentId: toRef(props, 'selectedEnvironmentId'),
  onUpdated: () => emit('updated'),
});
</script>

<template>
  <a-drawer v-model:open="drawerOpen" width="min(94vw, 1120px)" title="后端环境依赖管理" destroyOnClose>
    <a-alert type="info" show-icon message="Nacos 仅做地址与注册状态检测，不提供共享注册中心重启。凭据使用 AES-GCM 加密保存。" />
    <div class="environment-layout">
      <section class="environment-form">
        <div class="environment-section-heading">
          <div>
            <span class="environment-section-heading__eyebrow">ENVIRONMENT PROFILE</span>
            <h4>{{ state.activeId.value ? '编辑环境' : '新增环境' }}</h4>
          </div>
          <YButton v-if="state.activeId.value" type="link" @click="state.resetForm">
            <PlusOutlined />
            新增环境
          </YButton>
        </div>
        <a-form layout="vertical">
          <a-form-item label="环境名称" required><a-input v-model:value="state.form.name" placeholder="例如 华贵测试环境" /></a-form-item>
          <a-form-item label="Nacos 服务地址" extra="用于 TCP 连通与注册检测，推荐不带协议和路径">
            <a-input v-model:value="state.form.nacosServerAddr" placeholder="192.168.10.10:8848" />
          </a-form-item>
          <a-form-item label="Nacos 控制台" extra="用于快捷打开控制台，请勿包含 #/ 后的前端路由">
            <a-input v-model:value="state.form.nacosConsoleUrl" placeholder="http://192.168.10.10:8848/nacos/" />
          </a-form-item>
          <a-row :gutter="10">
            <a-col :span="12"><a-form-item label="Namespace"><a-input v-model:value="state.form.nacosNamespace" placeholder="例如 yss-datamiddle" /></a-form-item></a-col>
            <a-col :span="12"><a-form-item label="Group"><a-input v-model:value="state.form.nacosGroup" placeholder="例如 yss-dm" /></a-form-item></a-col>
          </a-row>
          <a-form-item label="Gateway 公开地址"><a-input v-model:value="state.form.gatewayPublicUrl" placeholder="http://gateway.example.com" /></a-form-item>
          <a-row :gutter="10">
            <a-col :span="12"><a-form-item label="Nacos 用户名"><a-input v-model:value="state.form.username" /></a-form-item></a-col>
            <a-col :span="12"><a-form-item label="Nacos 密码"><a-input-password v-model:value="state.form.password" /></a-form-item></a-col>
          </a-row>
          <a-form-item label="Nacos Token"><a-input-password v-model:value="state.form.token" /></a-form-item>
        </a-form>
        <div class="environment-form__actions">
          <YButton @click="state.resetForm">清空</YButton>
          <YButton type="primary" :loading="state.saving.value" @click="state.saveEnvironment">保存环境</YButton>
        </div>
      </section>
      <section class="environment-list">
        <div class="environment-list__heading">
          <div>
            <span class="environment-section-heading__eyebrow">SAVED PROFILES</span>
            <h4>已保存环境 <em>{{ state.environments.value.length }}</em></h4>
          </div>
          <span>选择后会自动回填到当前部署目标</span>
        </div>
        <a-spin :spinning="state.loading.value">
          <div class="environment-list__content">
            <EnvironmentCard
              v-for="environment in state.environments.value"
              :key="environment.id"
              :environment="environment"
              :selected="environment.id === props.selectedEnvironmentId"
              :editing="environment.id === state.activeId.value"
              @select="emit('select', environment)"
              @edit="state.editEnvironment(environment)"
              @remove="state.removeEnvironment(environment)"
            />
            <a-empty v-if="!state.environments.value.length" description="还没有环境配置，请先在左侧创建" />
          </div>
        </a-spin>
      </section>
    </div>
  </a-drawer>
</template>

<style scoped lang="less">
@import './style.less';
</style>
