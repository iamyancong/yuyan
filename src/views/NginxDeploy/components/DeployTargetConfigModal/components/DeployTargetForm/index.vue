<script setup lang="ts">
import { defineAsyncComponent } from 'vue';
import { ExclamationCircleOutlined } from '@ant-design/icons-vue';
import { YssFormily } from '@yss-ui/components/lite';
import DeployRootField from '../DeployRootField/index.vue';
import NginxInstanceField from '../NginxInstanceField/index.vue';
import type { DeployTargetFormEmits, DeployTargetFormProps } from './constant';
import { useDeployTargetForm } from './hooks/useDeployTargetForm';

defineOptions({ name: 'DeployTargetForm' });

const InlineFsExplorer = defineAsyncComponent(() => import('../InlineFsExplorer/index.vue'));

const props = defineProps<DeployTargetFormProps>();
const emit = defineEmits<DeployTargetFormEmits>();

const {
  formRef,
  formModel,
  selectedServer,
  selectedInstance,
  lockedScope,
  isExplorerOpen,
  occupiedMap,
  toggleExplorer,
  closeExplorer,
  handleSelectPath,
  handleUpdateOccupiedMap,
  listenPortSyncHint,
  listenPortSyncValue,
  listenPortPlaceholder,
  applyListenPortSync,
  syncingListenPortFromConf,
  canSyncListenPortFromConf,
  syncListenPortFromNginxConf,
} = useDeployTargetForm(props, emit);
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
        <template #listenPortField="{ value, onChange, disabled }">
          <div class="listen-port-field">
            <a-input-number
              :value="value"
              :min="1"
              :max="65535"
              :precision="0"
              :disabled="disabled"
              :placeholder="listenPortPlaceholder"
              class="listen-port-field__input"
              @update:value="(val: number | null) => onChange(val)"
            />
            <div v-if="listenPortSyncHint && listenPortSyncValue" class="listen-port-field__hint" role="status">
              <ExclamationCircleOutlined class="listen-port-field__hint-icon" />
              <span class="listen-port-field__hint-text">{{ listenPortSyncHint }}</span>
              <a-button
                type="link"
                size="small"
                class="listen-port-field__sync-btn"
                :disabled="disabled"
                @click="() => {
                  const nextPort = applyListenPortSync();
                  if (nextPort) onChange(nextPort);
                }"
              >
                同步为 {{ listenPortSyncValue }}
              </a-button>
            </div>
            <div v-if="formModel.projectType !== 'backend'" class="listen-port-field__actions">
              <a-tooltip
                :title="canSyncListenPortFromConf
                  ? '读取服务器上该目标的 Nginx 配置文件，解析 listen 端口后询问是否同步'
                  : '保存部署目标后才能从服务器读取 Nginx 配置'"
              >
                <span class="listen-port-field__action-wrap">
                  <a-button
                    type="link"
                    size="small"
                    class="listen-port-field__sync-btn"
                    :disabled="disabled || !canSyncListenPortFromConf"
                    :loading="syncingListenPortFromConf"
                    @click="syncListenPortFromNginxConf"
                  >
                    从 Nginx 配置同步
                  </a-button>
                </span>
              </a-tooltip>
              <span v-if="!canSyncListenPortFromConf" class="listen-port-field__action-tip">保存目标后可用</span>
            </div>
          </div>
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
            :is-explorer-open="isExplorerOpen"
            @update:model-value="onChange"
            @toggle-explorer="toggleExplorer"
            @update:occupied-map="handleUpdateOccupiedMap"
          />
        </template>
        <template #fsExplorerSlot>
          <transition name="explorer-slide">
            <InlineFsExplorer
              v-if="isExplorerOpen && selectedServer"
              :model-value="formModel.deployRoot"
              :server="selectedServer"
              :locked-root="lockedScope.root"
              :default-path="lockedScope.defaultPath"
              :scope-label="lockedScope.label"
              :occupied-map="occupiedMap"
              @update:model-value="handleSelectPath"
              @close="closeExplorer"
            />
          </transition>
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
