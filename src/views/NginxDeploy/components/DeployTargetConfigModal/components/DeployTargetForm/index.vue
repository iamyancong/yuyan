<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { YssFormily } from '@yss-ui/components/lite';
import type { DeployTargetPayload } from '@/api/deploy';
import type { FormilyRef } from '../../../../types';
import { useNginxDeployContext } from '../../../../hooks/useNginxDeployContext';
import { getPreferredNginxInstance } from '../../../../utils';
import DeployRootField from '../DeployRootField/index.vue';
import NginxInstanceField from '../NginxInstanceField/index.vue';

defineOptions({ name: 'DeployTargetForm' });

/** 部署目标表单属性。 */
interface DeployTargetFormProps {
  loading: boolean;
  form: DeployTargetPayload;
  schema: Record<string, unknown>;
  targetId?: number | null;
}

const props = defineProps<DeployTargetFormProps>();
const emit = defineEmits<{
  'update:form': [value: Partial<DeployTargetPayload>];
  formRefChange: [value: FormilyRef | null];
}>();
const formRef = ref<FormilyRef | null>(null);

/** 全局服务器列表上下文 */
const { servers } = useNginxDeployContext();

/** 部署目标表单双向绑定模型。 */
const formModel = computed({
  get: () => props.form,
  set: (value: Partial<DeployTargetPayload>) => emit('update:form', value || {}),
});

/** 当前选中的部署服务器 */
const selectedServer = computed(() => {
  if (!formModel.value.serverId) return null;
  return servers.value.find((s) => s.id === Number(formModel.value.serverId)) || null;
});

/** 当前选中的 Nginx 实例（未指定时自动回退为默认托管实例） */
const selectedInstance = computed(() => {
  if (!selectedServer.value) return null;
  const currentId = Number(formModel.value.nginxInstanceId || 0);
  if (currentId) {
    const matched = selectedServer.value.nginxInstances?.find((i) => i.id === currentId);
    if (matched) return matched;
  }
  return getPreferredNginxInstance(selectedServer.value);
});

watch(formRef, (instance) => emit('formRefChange', instance), { flush: 'post' });
onUnmounted(() => emit('formRefChange', null));
</script>

<template>
  <section class="target-config-form">
    <a-spin :spinning="loading" tip="正在加载项目分支信息...">
      <YssFormily ref="formRef" v-model:modelValue="formModel" :schema="schema">
        <template #targetBasicSection>
          <div class="target-form-section">
            <strong>项目与环境</strong>
            <span>选择发布源代码分支和部署服务器</span>
          </div>
        </template>
        <template #nginxInstanceField="{ value, onChange, disabled }">
          <NginxInstanceField
            :model-value="value ?? formModel.nginxInstanceId"
            :server="selectedServer"
            :instance="selectedInstance"
            :domain="formModel.serverName"
            :port="formModel.listenPort"
            :deploy-root="formModel.deployRoot"
            :disabled="disabled || formModel.projectType === 'backend'"
            @update:model-value="(val) => {
              onChange(val);
              formModel.nginxInstanceId = val || 0;
            }"
          />
        </template>
        <template #targetPathSection>
          <div class="target-form-section">
            <strong>{{ formModel.projectType === 'backend' ? '路径与产物' : '路径与访问' }}</strong>
            <span>{{ formModel.projectType === 'backend' ? '配置部署根目录和 Java Jar 产物相对路径' : '智能识别静态产物落点、Nginx 配置文件和访问入口' }}</span>
          </div>
        </template>
        <template #deployRoot="{ value, onChange }">
          <DeployRootField
            :model-value="value"
            :project-type="formModel.projectType"
            :project-id="formModel.projectId"
            :project-name="formModel.projectName"
            :project-description="formModel.projectDescription"
            :default-branch="formModel.defaultBranch"
            :server-id="formModel.serverId"
            :nginx-instance-id="formModel.nginxInstanceId"
            :build-command="formModel.buildCommand"
            :artifact-dir="formModel.artifactDir"
            :target-id="targetId"
            @update:model-value="onChange"
          />
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
</template>

<style scoped lang="less">
@import './style.less';
</style>
