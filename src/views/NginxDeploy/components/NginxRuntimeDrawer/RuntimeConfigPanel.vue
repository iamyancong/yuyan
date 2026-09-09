<script setup lang="ts">
import { YssFormily } from '@yss-ui/components/lite';
import type { NginxRuntimePayload } from '@/api/deploy';
import { nginxRuntimeFormSchema } from './constant';

defineOptions({ name: 'NginxRuntimeConfigPanel' });

/** Nginx 托管运行时配置面板属性 */
interface RuntimeConfigPanelProps {
  modelValue: NginxRuntimePayload;
  initialized: boolean;
  initializing: boolean;
}

defineProps<RuntimeConfigPanelProps>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: Partial<NginxRuntimePayload>): void;
}>();
</script>

<template>
  <section class="nginx-runtime-card nginx-runtime-config-card">
    <div class="nginx-runtime-section-title">
      <div class="nginx-runtime-section-title__left">
        <strong>{{ initialized ? '运行时配置' : '初始化配置' }}</strong>
        <span>{{ initialized ? '当前服务器已记录的 yuyan 托管 Nginx 路径' : '默认写入 /opt/yuyan；权限不足时请开启 sudo 或改目录' }}</span>
      </div>
      <span class="nginx-runtime-card__badge">{{ initialized ? '已初始化' : '待初始化' }}</span>
    </div>
    <YssFormily
      :model-value="modelValue"
      :schema="nginxRuntimeFormSchema"
      :disabled="initializing"
      @update:modelValue="(value: Partial<NginxRuntimePayload>) => emit('update:modelValue', value || {})"
    />
  </section>
</template>
