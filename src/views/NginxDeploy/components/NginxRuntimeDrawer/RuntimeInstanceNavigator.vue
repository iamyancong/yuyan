<script setup lang="ts">
import { YButton } from '@ycwang-dev/components/lite';
import {
  AppstoreOutlined,
  CheckCircleOutlined,
  ClusterOutlined,
  CodeOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
} from '@ant-design/icons-vue';
import type { NginxInstance } from '@/api/deploy';
import { NGINX_RUNTIME_STATUS_COLOR, NGINX_RUNTIME_STATUS_LABEL } from './constant';

defineOptions({ name: 'NginxRuntimeInstanceNavigator' });

/** Nginx 实例导航属性 */
interface RuntimeInstanceNavigatorProps {
  instances: NginxInstance[];
  activeInstanceId: number | null;
  hasManagedInstance: boolean;
}

defineProps<RuntimeInstanceNavigatorProps>();

const emit = defineEmits<{
  (e: 'selectInstance', value: number): void;
  (e: 'createInstance', value: NginxInstance['instanceType']): void;
  (e: 'editInstance'): void;
  (e: 'deleteInstance'): void;
}>();

/**
 * 获取实例状态文案。
 * @param instance Nginx 实例
 * @returns 状态文案
 */
const getInstanceStatusLabel = (instance: NginxInstance) => NGINX_RUNTIME_STATUS_LABEL[instance.status || 'unknown'] || '未知';

/**
 * 获取实例状态颜色。
 * @param instance Nginx 实例
 * @returns 标签颜色
 */
const getInstanceStatusColor = (instance: NginxInstance) => NGINX_RUNTIME_STATUS_COLOR[instance.status || 'unknown'] || 'default';

/**
 * 获取实例主路径。
 * @param instance Nginx 实例
 * @returns 可展示路径
 */
const getInstancePath = (instance: NginxInstance) => instance.defaultNginxConfPath || instance.nginxRoot || '-';
</script>

<template>
  <section class="nginx-runtime-card nginx-runtime-card--navigation">
    <div class="nginx-runtime-section-title">
      <div class="nginx-runtime-section-title__left">
        <strong>实例管理</strong>
        <span>部署目标会绑定到这里选中的具体 Nginx 实例</span>
      </div>
      <a-tooltip :title="hasManagedInstance ? '同一服务器只能新增一个托管 Nginx；多个 yuyan 主应用请在 nginx.conf 中新增 server' : ''">
        <YButton size="small" :disabled="hasManagedInstance" @click="emit('createInstance', 'managed')">
          <template #icon><PlusOutlined /></template>
          新增托管
        </YButton>
      </a-tooltip>
    </div>

    <div class="nginx-instance-list">
      <button
        v-for="instance in instances"
        :key="instance.id"
        type="button"
        class="nginx-instance-card"
        :class="{ 'nginx-instance-card--active': instance.id === activeInstanceId }"
        @click="emit('selectInstance', instance.id)"
      >
        <span class="nginx-instance-card__glow" />
        <span class="nginx-instance-card__top">
          <span class="nginx-instance-card__icon">
            <ClusterOutlined v-if="instance.instanceType === 'managed'" />
            <AppstoreOutlined v-else />
          </span>
          <span class="nginx-instance-card__identity">
            <strong>{{ instance.name }}</strong>
            <small>{{ instance.instanceType === 'managed' ? '系统托管实例' : '外部已有实例' }}</small>
          </span>
          <a-tag :color="getInstanceStatusColor(instance)">{{ getInstanceStatusLabel(instance) }}</a-tag>
        </span>

        <span class="nginx-instance-card__meta">
          <span><CheckCircleOutlined />绑定 {{ instance.targetCount || 0 }} 个目标</span>
          <span><CodeOutlined />{{ instance.instanceType === 'managed' ? '托管' : '已有' }}</span>
        </span>

        <span class="nginx-instance-card__bottom">
          <a-tooltip :title="getInstancePath(instance)">
            <code>{{ getInstancePath(instance) }}</code>
          </a-tooltip>
          <span v-if="instance.id === activeInstanceId" class="nginx-instance-card__actions" @click.stop>
            <YButton size="small" @click="emit('editInstance')">
              <template #icon><EditOutlined /></template>
              编辑
            </YButton>
            <a-popconfirm
              v-if="instance.name !== '系统 Nginx'"
              title="确认删除该 Nginx 实例？"
              ok-text="删除"
              cancel-text="取消"
              @confirm="emit('deleteInstance')"
            >
              <YButton size="small" danger :disabled="Boolean(instance.targetCount)">
                <template #icon><DeleteOutlined /></template>
                删除
              </YButton>
            </a-popconfirm>
          </span>
        </span>
      </button>
    </div>
  </section>
</template>
