<script setup lang="ts">
import { YssFormily } from '@ycwang-dev/components/lite';
import type { NginxRuntimeDrawerEmits, NginxRuntimeDrawerProps } from './constant';
import RuntimeConfigPanel from './RuntimeConfigPanel.vue';
import RuntimeContextBar from './RuntimeContextBar.vue';
import RuntimeFooterBar from './RuntimeFooterBar.vue';
import RuntimeInstanceNavigator from './RuntimeInstanceNavigator.vue';
import RuntimePathPreview from './RuntimePathPreview.vue';
import RuntimeProgressPanel from './RuntimeProgressPanel.vue';
import { useNginxRuntimeDrawerView } from './hooks/useNginxRuntimeDrawerView';

defineOptions({ name: 'NginxRuntimeDrawer' });

const props = defineProps<NginxRuntimeDrawerProps>();
const emit = defineEmits<NginxRuntimeDrawerEmits>();

const {
  activeInstance,
  activeInstanceTypeLabel,
  canDownloadArchive,
  canManagedOperate,
  canOperate,
  computedInstanceFormSchema,
  formModel,
  hasManagedInstance,
  hasProgress,
  hasServer,
  initialized,
  instanceFormModel,
  instanceFormVisible,
  instanceOptions,
  isManagedInstance,
  monacoReadonlyOptions,
  pathPreviewTip,
  pathRows,
  progressLogContent,
  serverOptions,
  statusColor,
  statusLabel,
  title,
  versionLabel,
  visible,
} = useNginxRuntimeDrawerView(props, emit);
</script>

<template>
  <a-drawer
    v-model:open="visible"
    :bodyStyle="{ padding: '0' }"
    :title="title"
    width="min(1180px, 94vw)"
    class="nginx-runtime-drawer"
    root-class-name="nginx-runtime-drawer-root"
    :destroy-on-close="false"
  >
    <a-spin :spinning="loading">
      <div class="nginx-runtime-shell">
        <RuntimeContextBar
          :server="server"
          :active-instance-id="activeInstanceId"
          :active-instance="activeInstance"
          :has-server="hasServer"
          :server-options="serverOptions"
          :instance-options="instanceOptions"
          :active-instance-type-label="activeInstanceTypeLabel"
          :status-label="statusLabel"
          :status-color="statusColor"
          :version-label="versionLabel"
          @change-server="(value) => emit('changeServer', value)"
          @select-instance="(value) => emit('selectInstance', value)"
        />

        <a-empty v-if="!hasServer" description="请在上方选择一台服务器" class="nginx-runtime-empty" />

        <div v-else class="nginx-runtime-body">
          <div class="nginx-runtime-body__left">
            <RuntimeInstanceNavigator
              :instances="instances"
              :active-instance-id="activeInstanceId"
              :has-managed-instance="hasManagedInstance"
              @select-instance="(value) => emit('selectInstance', value)"
              @create-instance="(value) => emit('createInstance', value)"
              @edit-instance="emit('editInstance')"
              @delete-instance="emit('deleteInstance')"
            />
          </div>

          <div class="nginx-runtime-body__right">
            <RuntimeConfigPanel
              v-if="isManagedInstance"
              v-model:modelValue="formModel"
              :initialized="initialized"
              :initializing="initializing"
            />
            <RuntimePathPreview
              :is-managed-instance="isManagedInstance"
              :title="isManagedInstance ? '路径预览' : '实例路径与命令'"
              :tip="pathPreviewTip"
              :rows="pathRows"
              :can-download-archive="canDownloadArchive"
              :archive-downloading="archiveDownloading"
              @download-archive="(value) => emit('downloadArchive', value)"
            />
          </div>
        </div>

        <RuntimeProgressPanel
          v-if="hasProgress"
          :progress="progress"
          :content="progressLogContent"
          :monaco-options="monacoReadonlyOptions"
        />
      </div>
    </a-spin>

    <template #footer>
      <RuntimeFooterBar
        :initialized="initialized"
        :initializing="initializing"
        :can-operate="canOperate"
        :can-managed-operate="canManagedOperate"
        :active-instance="activeInstance"
        :action-loading="actionLoading"
        @refresh="emit('refresh')"
        @action="(value) => emit('action', value)"
        @close="visible = false"
        @init="emit('init')"
      />
    </template>
  </a-drawer>

  <a-modal
    v-model:open="instanceFormVisible"
    title="编辑 Nginx 实例"
    width="min(900px, 94vw)"
    :confirmLoading="instanceSaving"
    :maskClosable="!instanceSaving"
    :closable="!instanceSaving"
    :bodyStyle="{ maxHeight: 'calc(100vh - 220px)', overflowY: 'auto', padding: '18px 18px 2px 0' }"
    @ok="emit('saveInstance')"
  >
    <YssFormily :key="instanceFormKey" v-model:modelValue="instanceFormModel" :schema="computedInstanceFormSchema" />
  </a-modal>
</template>

<style scoped lang="less">
@import './style.less';
</style>

<style lang="less">
/* 全局样式覆盖，确保没有继承当前组件 scoped data-v 属性的第三方组件（如 YButton）在暗色模式下能正确渲染 */
html[data-theme='dark'] .nginx-runtime-drawer-root {
  // 1. 默认按钮样式优化（半透明毛玻璃质感，白色/近白色文字）
  .ant-btn:not(.ant-btn-primary):not(.ant-btn-dangerous):not(.ant-btn-text):not(.ant-btn-link) {
    background: rgba(255, 255, 255, 0.08) !important;
    border-color: rgba(255, 255, 255, 0.16) !important;
    color: rgba(255, 255, 255, 0.85) !important;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15) !important;

    &, span, .anticon {
      color: rgba(255, 255, 255, 0.85) !important;
    }

    &:hover:not([disabled]):not(.ant-btn-disabled) {
      background: rgba(255, 255, 255, 0.15) !important;
      border-color: var(--primary-color) !important;
      color: var(--primary-color) !important;

      &, span, .anticon {
        color: var(--primary-color) !important;
      }
    }

    &:active:not([disabled]):not(.ant-btn-disabled) {
      background: rgba(255, 255, 255, 0.03) !important;
    }
  }

  // 2. 禁用状态按钮优化（提升暗色模式背景下的清晰度与质感）
  .ant-btn[disabled],
  .ant-btn.ant-btn-disabled {
    background: rgba(255, 255, 255, 0.04) !important;
    border-color: rgba(255, 255, 255, 0.08) !important;
    color: rgba(255, 255, 255, 0.3) !important;
    box-shadow: none !important;

    &, span, .anticon {
      color: rgba(255, 255, 255, 0.3) !important;
    }
  }
}
</style>

