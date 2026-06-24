<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { YButton, YssFormily } from '@yss-ui/components/lite';
import type { DeployServerPayload } from '@/api/deploy';
import type { FormilyRef } from '../../types';
import { serverFormSchema } from '../../constant';

defineOptions({ name: 'ServerConfigDrawer' });

/** 服务器配置抽屉属性 */
interface ServerConfigDrawerProps {
  open: boolean;
  saving: boolean;
  formKey: number;
  form: DeployServerPayload;
}

const props = defineProps<ServerConfigDrawerProps>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'update:form', value: Partial<DeployServerPayload>): void;
  (e: 'formRefChange', value: FormilyRef | null): void;
  (e: 'save'): void;
}>();

const formRef = ref<FormilyRef | null>(null);

/** 抽屉显隐状态 */
const visible = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
});

/** 服务器表单模型 */
const formModel = computed({
  get: () => ({ ...props.form }),
  set: (value: Partial<DeployServerPayload>) => {
    emit('update:form', value || {});
  },
});

watch(formRef, (instance) => emit('formRefChange', instance), { flush: 'post' });

onUnmounted(() => {
  emit('formRefChange', null);
});
</script>

<template>
  <a-drawer v-model:open="visible" title="服务器配置" width="min(1080px, 94vw)" class="server-config-drawer" :destroy-on-close="true">
    <div class="server-config-shell">
      <section class="server-config-form">
        <YssFormily :key="formKey" ref="formRef" v-model:modelValue="formModel" :schema="serverFormSchema">
          <template #serverBasicSection>
            <div class="server-form-section">
              <strong>基础连接</strong>
              <span>填写服务器地址、SSH 端口和登录账号</span>
            </div>
          </template>
          <template #serverAuthSection>
            <div class="server-form-section">
              <strong>认证凭据</strong>
              <span>配置密码或 SSH Key 认证信息</span>
            </div>
          </template>
          <template #serverNginxSection>
            <div class="server-form-section">
              <strong>Nginx 配置</strong>
              <span>已有 Nginx 的服务器可配置默认路径和发布后执行命令</span>
            </div>
          </template>
        </YssFormily>
      </section>
    </div>
    <template #footer>
      <a-space class="server-config-drawer__footer">
        <YButton :disabled="saving" @click="visible = false">取消</YButton>
        <YButton type="primary" :loading="saving" @click="emit('save')">确定</YButton>
      </a-space>
    </template>
  </a-drawer>
</template>

<style scoped lang="less">
@import './style.less';
</style>
