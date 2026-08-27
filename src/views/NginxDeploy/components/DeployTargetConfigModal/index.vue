<script setup lang="ts">
import { computed } from 'vue';
import {
  ApartmentOutlined,
  ArrowRightOutlined,
  CoffeeOutlined,
  FileSearchOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons-vue';
import type { DeployTargetPayload } from '@/api/deploy';
import type { FormilyRef } from '../../types';
import DeployTargetForm from './components/DeployTargetForm/index.vue';

defineOptions({ name: 'DeployTargetConfigModal' });

/** 部署目标配置弹窗属性 */
interface DeployTargetConfigModalProps {
  open: boolean;
  saving: boolean;
  loading: boolean;
  form: DeployTargetPayload;
  schema: Record<string, unknown>;
  targetId?: number | null;
}

const props = defineProps<DeployTargetConfigModalProps>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'update:form', value: Partial<DeployTargetPayload>): void;
  (e: 'formRefChange', value: FormilyRef | null): void;
  (e: 'inspect'): void;
  (e: 'manageJava'): void;
  (e: 'manageEnvironment'): void;
  (e: 'save'): void;
}>();

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

/** 更新部署目标表单值。 */
const updateForm = (value: Partial<DeployTargetPayload>) => {
  formModel.value = value;
};

/** 转发表单实例变化。 */
const updateFormRef = (value: FormilyRef | null) => emit('formRefChange', value);
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
    :destroy-on-close="true"
    @ok="emit('save')"
  >
    <div class="target-config-shell">
      <div class="target-config-guide" :class="{ 'is-compact': formModel.projectType !== 'backend' }">
        <div class="target-config-guide__summary">
          <span class="target-config-guide__icon" aria-hidden="true">
            <InfoCircleOutlined />
          </span>
          <div class="target-config-guide__copy">
            <span class="target-config-guide__eyebrow">{{ formModel.projectType === 'backend' ? '后端发布策略' : '发布提示' }}</span>
            <p v-if="formModel.projectType === 'backend'">
              使用 releases/current/shared 版本化目录，兼容 conf、logs、nas、target 入口；健康检查失败时自动恢复上一版本。
            </p>
            <p v-else>
              发布会先备份原目录再上传构建产物；已有 Nginx 已手工配置时，请关闭“平台管理站点”，避免保存时自动同步和重载。
            </p>
          </div>
        </div>

        <div v-if="formModel.projectType === 'backend'" class="target-config-guide__tools">
          <span class="target-config-guide__tools-label">部署前工具</span>
          <div class="target-config-guide__actions">
            <a-button class="target-guide-action" :disabled="loading" @click="emit('inspect')">
              <span class="target-guide-action__icon"><FileSearchOutlined /></span>
              <span class="target-guide-action__copy">
                <strong>检测项目配置</strong>
                <small>校验路径与运行参数</small>
              </span>
              <ArrowRightOutlined class="target-guide-action__arrow" />
            </a-button>
            <a-button class="target-guide-action" :disabled="loading" @click="emit('manageJava')">
              <span class="target-guide-action__icon"><CoffeeOutlined /></span>
              <span class="target-guide-action__copy">
                <strong>管理 Java 环境</strong>
                <small>维护构建与运行 JDK</small>
              </span>
              <ArrowRightOutlined class="target-guide-action__arrow" />
            </a-button>
            <a-button class="target-guide-action" :disabled="loading" @click="emit('manageEnvironment')">
              <span class="target-guide-action__icon"><ApartmentOutlined /></span>
              <span class="target-guide-action__copy">
                <strong>管理环境依赖</strong>
                <small>复用 Nacos / Gateway 配置</small>
              </span>
              <ArrowRightOutlined class="target-guide-action__arrow" />
            </a-button>
          </div>
        </div>
      </div>
      <DeployTargetForm
        v-if="visible"
        :loading="loading"
        :form="formModel"
        :schema="schema"
        :target-id="targetId"
        @update:form="updateForm"
        @form-ref-change="updateFormRef"
      />
    </div>
  </a-modal>
</template>

<style scoped lang="less">
@import './style.less';
</style>
