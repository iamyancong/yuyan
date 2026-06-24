<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { InfoCircleOutlined } from '@ant-design/icons-vue';
import { YssFormily } from '@yss-ui/components/lite';
import type { DeployTargetPayload } from '@/api/deploy';
import type { FormilyRef } from '../../types';

defineOptions({ name: 'DeployTargetConfigModal' });

/** 部署目标配置弹窗属性 */
interface DeployTargetConfigModalProps {
  open: boolean;
  saving: boolean;
  loading: boolean;
  form: DeployTargetPayload;
  schema: Record<string, unknown>;
}

const props = defineProps<DeployTargetConfigModalProps>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'update:form', value: Partial<DeployTargetPayload>): void;
  (e: 'formRefChange', value: FormilyRef | null): void;
  (e: 'save'): void;
}>();

const formRef = ref<FormilyRef | null>(null);

/** 弹窗显隐状态 */
const visible = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
});

/** 部署目标表单模型 */
const formModel = computed({
  get: () => props.form,
  set: (value: Partial<DeployTargetPayload>) => emit('update:form', value || {}),
});

watch(formRef, (instance) => emit('formRefChange', instance), { flush: 'post' });

onUnmounted(() => {
  emit('formRefChange', null);
});
</script>

<template>
  <a-modal
    v-model:open="visible"
    title="部署配置"
    width="min(1080px, 94vw)"
    class="target-config-modal"
    :bodyStyle="{ maxHeight: 'calc(100vh - 200px)', overflowY: 'auto', padding: '10px 18px 12px 0px' }"
    style="top: 40px"
    :confirmLoading="saving"
    :maskClosable="!saving && !loading"
    :closable="!saving && !loading"
    :okButtonProps="{ disabled: loading }"
    @ok="emit('save')"
  >
    <div class="target-config-shell">
      <div class="target-config-tip">
        <InfoCircleOutlined />
        <span>测试环境发布会上传构建产物，并将原目录备份到 .yuyan-backups。</span>
      </div>
      <section class="target-config-form">
        <a-spin :spinning="loading" tip="正在加载项目分支信息...">
          <YssFormily ref="formRef" v-model:modelValue="formModel" :schema="schema">
            <template #targetBasicSection>
              <div class="target-form-section">
                <strong>项目与环境</strong>
                <span>选择发布源代码分支和部署服务器</span>
              </div>
            </template>
            <template #targetPathSection>
              <div class="target-form-section">
                <strong>路径与访问</strong>
                <span>配置静态产物落点、Nginx 配置文件和访问入口</span>
              </div>
            </template>
            <template #targetPublishSection>
              <div class="target-form-section">
                <strong>构建与 Nginx</strong>
                <span>设置构建命令、产物目录和发布后的 Nginx 动作</span>
              </div>
            </template>
          </YssFormily>
        </a-spin>
      </section>
    </div>
  </a-modal>
</template>

<style scoped lang="less">
@import './style.less';
</style>
