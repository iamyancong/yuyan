<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import {
  ApartmentOutlined,
  ArrowRightOutlined,
  CoffeeOutlined,
  FileSearchOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons-vue';
import { YssFormily } from '@ycwang-dev/components/lite';
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
  (e: 'inspect'): void;
  (e: 'manageJava'): void;
  (e: 'manageEnvironment'): void;
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
            <p v-else>测试环境发布会上传构建产物，并将原目录备份到 .yuyan-backups。</p>
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
                <strong>{{ formModel.projectType === 'backend' ? '路径与产物' : '路径与访问' }}</strong>
                <span>{{ formModel.projectType === 'backend' ? '配置部署根目录和 Java Jar 产物相对路径' : '配置静态产物落点、Nginx 配置文件和访问入口' }}</span>
              </div>
            </template>
            <template #targetPublishSection>
              <div class="target-form-section">
                <strong>{{ formModel.projectType === 'backend' ? '构建与服务控制' : '构建与 Nginx' }}</strong>
                <span>{{ formModel.projectType === 'backend' ? '配置本地打包、受控进程托管、依赖地址和健康探测' : '设置构建命令、产物目录和发布后的 Nginx 动作' }}</span>
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
