<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { YButton, YssFormily } from '@yss-ui/components/lite';
import type { DeployServerPayload } from '@/api/deploy';
import type { FormilyRef } from '../../types';
import { serverFormSchema } from '../../constant';
import type { SshFailureAction, SshFailureField, SshFailureInfo } from '../../sshFailureGuide';
import type { ServerDuplicateInfo } from '../../serverDuplicatePolicy';
import SshFailureGuideCard from '../SshFailureGuideCard/index.vue';

defineOptions({ name: 'ServerConfigDrawer' });

/** 服务器配置抽屉属性 */
interface ServerConfigDrawerProps {
  open: boolean;
  saving: boolean;
  formKey: number;
  form: DeployServerPayload;
  /** 保存时 SSH 校验失败详情（#47） */
  failure?: SshFailureInfo | null;
  /** 请求聚焦的字段 */
  focusRequest?: { field: SshFailureField; token: number } | null;
  /** 保存时查重失败：地址或名称已存在（#47） */
  duplicate?: ServerDuplicateInfo | null;
}

const props = defineProps<ServerConfigDrawerProps>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'update:form', value: Partial<DeployServerPayload>): void;
  (e: 'formRefChange', value: FormilyRef | null): void;
  (e: 'save'): void;
  /** 查看已有服务器 */
  (e: 'viewDuplicate'): void;
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

/**
 * 聚焦被标红的字段：输入框直接 focus，开关聚焦按钮。
 * @param field 字段名
 */
const focusField = async (field: SshFailureField) => {
  if (!field) return;
  await nextTick();
  window.setTimeout(() => {
    const root = document.querySelector('.server-config-drawer');
    const errorItem = root?.querySelector('[class*="item-error"]');
    const control = errorItem?.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, button[role="switch"], .ant-switch, .ant-select-selector');
    control?.focus();
    errorItem?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 60);
};

watch(() => props.focusRequest?.token, () => {
  if (props.focusRequest) void focusField(props.focusRequest.field);
});

/**
 * 处理引导卡片按钮：抽屉内的修改类动作只聚焦对应字段。
 * @param action 引导动作
 */
const handleGuideAction = (action: SshFailureAction) => {
  if (action.key === 'retry') {
    emit('save');
    return;
  }
  void focusField((action.focusField || props.failure?.field || '') as SshFailureField);
};

onUnmounted(() => {
  emit('formRefChange', null);
});
</script>

<template>
  <a-drawer v-model:open="visible" title="服务器配置" width="min(1080px, 94vw)" class="server-config-drawer" :destroy-on-close="true">
    <div class="server-config-shell">
      <a-alert v-if="duplicate" class="server-config-duplicate" type="error" show-icon :message="duplicate.message">
        <template #description>
          {{ duplicate.code === 'server_duplicate' ? '同一团队内，IP / 域名、SSH 端口和登录账号都相同的服务器只能有一台；端口或账号不同可以保存。' : '同一团队内服务器名称不能重复，请换一个名称。' }}
        </template>
        <template #action>
          <YButton size="small" type="primary" @click="emit('viewDuplicate')">查看已有服务器</YButton>
        </template>
      </a-alert>
      <SshFailureGuideCard v-if="failure" :failure="failure" @action="handleGuideAction" />
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
              <strong>认证与权限</strong>
              <span>配置密码或 SSH Key 认证信息及 Sudo 提权权限</span>
            </div>
          </template>
        </YssFormily>
      </section>
    </div>
    <template #footer>
      <a-space class="server-config-drawer__footer">
        <YButton :disabled="saving" @click="visible = false">取消</YButton>
        <span v-if="saving" class="server-config-drawer__verifying">正在校验 SSH 登录…</span>
        <YButton type="primary" :loading="saving" @click="emit('save')">{{ saving ? '校验中' : '确定' }}</YButton>
      </a-space>
    </template>
  </a-drawer>
</template>

<style scoped lang="less">
@import './style.less';
</style>
