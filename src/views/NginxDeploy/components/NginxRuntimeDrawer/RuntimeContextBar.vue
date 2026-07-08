<script setup lang="ts">
import type { SelectProps } from 'ant-design-vue';
import type { DeployServer, NginxInstance } from '@/api/deploy';

defineOptions({ name: 'NginxRuntimeContextBar' });

/** Nginx 管理抽屉顶部上下文属性 */
interface RuntimeContextBarProps {
  server: DeployServer | null;
  activeInstanceId: number | null;
  activeInstance: NginxInstance | null;
  hasServer: boolean;
  serverOptions: SelectProps['options'];
  instanceOptions: SelectProps['options'];
  activeInstanceTypeLabel: string;
  statusLabel: string;
  statusColor: string;
  versionLabel: string;
}

defineProps<RuntimeContextBarProps>();

const emit = defineEmits<{
  (e: 'changeServer', value: number): void;
  (e: 'selectInstance', value: number): void;
}>();
</script>

<template>
  <section class="nginx-runtime-context">
    <div class="nginx-runtime-context__select nginx-runtime-context__select--server">
      <span class="nginx-runtime-context__label">服务器</span>
      <a-select
        :value="server?.id || undefined"
        :options="serverOptions"
        placeholder="请选择服务器"
        class="project-select"
        show-search
        option-filter-prop="searchKey"
        option-label-prop="title"
        popup-class-name="project-select-dropdown"
        @change="(value: unknown) => emit('changeServer', Number(value))"
      />
    </div>

    <template v-if="hasServer">
      <div class="nginx-runtime-context__select">
        <span class="nginx-runtime-context__label">Nginx 实例</span>
        <a-select
          :value="activeInstanceId || undefined"
          :options="instanceOptions"
          placeholder="请选择 Nginx 实例"
          class="project-select"
          show-search
          option-filter-prop="searchKey"
          option-label-prop="title"
          popup-class-name="project-select-dropdown"
          @change="(value: unknown) => emit('selectInstance', Number(value))"
        />
      </div>
      <div class="nginx-runtime-context__pill">
        <span>类型</span>
        <a-tag>{{ activeInstance ? activeInstanceTypeLabel : '-' }}</a-tag>
      </div>
      <div class="nginx-runtime-context__pill">
        <span>状态</span>
        <a-tag :color="statusColor">{{ statusLabel }}</a-tag>
      </div>
      <div class="nginx-runtime-context__version">
        <span>版本</span>
        <strong>{{ versionLabel }}</strong>
      </div>
    </template>
  </section>
</template>
