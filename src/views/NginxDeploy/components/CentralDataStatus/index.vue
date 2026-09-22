<script setup lang="ts">
import { YButton } from '@yss-ui/components/lite';
import type { CentralDataStatusProps } from './constant';

defineProps<CentralDataStatusProps>();
const emit = defineEmits<{ retry: [] }>();
</script>

<template>
  <a-alert
    v-if="error || info"
    class="central-data-status"
    :type="info ? 'info' : warning ? 'warning' : 'error'"
    show-icon
    :message="title"
    :description="description"
  >
    <template v-if="error" #action>
      <YButton size="small" @click="emit('retry')">立即重试</YButton>
    </template>
  </a-alert>
</template>
