<script setup lang="ts">
import { YButton } from '@ycwang-dev/components/lite';
import {
  CheckCircleOutlined,
  CloseOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  SyncOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons-vue';
import type { NginxInstance, NginxRuntimeAction } from '@/api/deploy';

defineOptions({ name: 'NginxRuntimeFooterBar' });

/** Nginx 抽屉底部操作栏属性 */
interface RuntimeFooterBarProps {
  initialized: boolean;
  initializing: boolean;
  canOperate: boolean;
  canManagedOperate: boolean;
  activeInstance: NginxInstance | null;
  actionLoading: NginxRuntimeAction | '';
}

defineProps<RuntimeFooterBarProps>();

const emit = defineEmits<{
  (e: 'refresh'): void;
  (e: 'action', value: NginxRuntimeAction): void;
  (e: 'close'): void;
  (e: 'init'): void;
}>();
</script>

<template>
  <div class="nginx-runtime-footer">
    <a-space class="nginx-runtime-footer__group">
      <YButton :disabled="initializing" @click="emit('refresh')">
        <template #icon><SyncOutlined /></template>
        刷新状态
      </YButton>
      <YButton :disabled="!canOperate" :loading="actionLoading === 'test'" @click="emit('action', 'test')">
        <template #icon><CheckCircleOutlined /></template>
        校验
      </YButton>
      <YButton :disabled="!canManagedOperate" :loading="actionLoading === 'start'" @click="emit('action', 'start')">
        <template #icon><PoweroffOutlined /></template>
        启动
      </YButton>
      <YButton :disabled="!canOperate" :loading="actionLoading === 'reload'" @click="emit('action', 'reload')">
        <template #icon><ReloadOutlined /></template>
        重载
      </YButton>
      <YButton :disabled="!canManagedOperate" :loading="actionLoading === 'stop'" danger @click="emit('action', 'stop')">
        <template #icon><CloseOutlined /></template>
        停止
      </YButton>
    </a-space>

    <a-space class="nginx-runtime-footer__group nginx-runtime-footer__group--end">
      <YButton :disabled="initializing" @click="emit('close')">关闭</YButton>
      <YButton type="primary" :disabled="activeInstance?.instanceType !== 'managed'" :loading="initializing" @click="emit('init')">
        <template #icon><ThunderboltOutlined /></template>
        {{ initialized ? '重新初始化' : '开始初始化' }}
      </YButton>
    </a-space>
  </div>
</template>
