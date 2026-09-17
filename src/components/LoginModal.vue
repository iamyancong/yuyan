<script setup lang="ts">
import LoginModal from './LoginModal/index.vue';
import type { LoginModalProps, LoginModalEmits } from './LoginModal/constant';

defineOptions({ name: 'LoginModal' });

const props = defineProps<LoginModalProps>();
const emit = defineEmits<LoginModalEmits>();
</script>

<template>
  <LoginModal
    :visible="props.visible"
    @update:visible="(val: boolean) => emit('update:visible', val)"
    @login-success="() => emit('login-success')"
  />
</template>
