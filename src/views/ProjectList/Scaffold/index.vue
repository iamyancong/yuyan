<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue';
import { useScaffold } from './hooks/useScaffold';
import { useScaffoldDownload } from './hooks/useScaffoldDownload';
import { FRAMEWORK_OPTIONS } from './constant';
import ApplicationInfoCard from './components/ApplicationInfoCard.vue';
import GitLabConfigCard from './components/GitLabConfigCard.vue';

const {
  form,
  progress,
  loading,
  result,
  handleCreate,
  handleReset,
  visibilityOptions,
  isAuthenticated,
  gitlabContextReady,
  namespaceCacheKey,
  rules,
  formRef,
} = useScaffold();
const { handleDownload } = useScaffoldDownload(result);

/** GitOps 配置弹窗体积较大，仅在打开时加载 */
const GitOpsConfigModal = defineAsyncComponent(() => import('@/components/GitOpsConfigModal/index.vue'));

/** 创建进度工作台仅在任务可见时加载 */
const ScaffoldProgressWorkbench = defineAsyncComponent(() => import('./components/ScaffoldProgressWorkbench/index.vue'));

const gitopsVisible = ref(false);
const returnToWorkbenchOnGitOpsClose = ref(true);

const frameworkOptions = FRAMEWORK_OPTIONS as unknown as { label: string; value: string; disabled?: boolean }[];
const currentTemplateLabel = computed(() => {
  const found = frameworkOptions.find((opt) => opt.value === (form.framework as string));
  return found?.label ?? '通用模板';
});

/**
 * 提交创建微应用。
 */
const handleCreateClick = async () => {
  await handleCreate();
};

/**
 * 从创建结果跳转到 GitOps 配置。
 */
const handleGotoGitOps = () => {
  progress.visible = false;
  gitopsVisible.value = true;
  returnToWorkbenchOnGitOpsClose.value = true;
};

/**
 * GitOps 配置提交成功后关闭回跳。
 */
const handleGitOpsSuccess = () => {
  returnToWorkbenchOnGitOpsClose.value = false;
};

/**
 * 关闭创建进度工作台。
 */
const handleWorkbenchClose = () => {
  progress.visible = false;
  handleReset();
};

/**
 * 处理 GitOps 弹窗显隐同步。
 * @param visible 弹窗是否打开
 */
const handleGitOpsUpdateOpen = (visible: boolean) => {
  gitopsVisible.value = visible;
  if (!visible && returnToWorkbenchOnGitOpsClose.value && progress.result) {
    progress.visible = true;
  }
  if (!visible) {
    returnToWorkbenchOnGitOpsClose.value = true;
  }
};
</script>

<template>
  <div class="scaffold-page">
    <div class="page-header">
      <div class="page-header__main">
        <div>
          <div class="page-kicker">Micro App Console</div>
          <a-typography-title :level="3" class="page-title">创建微应用</a-typography-title>
          <a-typography-text type="secondary" class="page-subtitle">快速创建前端微应用，完善基础信息并可一键推送至 GitLab</a-typography-text>
        </div>
        <div class="title-tags">
          <span class="meta-label">当前模板</span>
          <a-tag color="processing" class="template-tag">{{ currentTemplateLabel }}</a-tag>
        </div>
      </div>
      <div class="page-flow">
        <span>创建配置</span>
        <i />
        <span>GitLab 推送</span>
        <i />
        <span>执行状态</span>
      </div>
    </div>

    <a-form ref="formRef" :model="form" :rules="rules" layout="vertical" class="scaffold-form" @submit.prevent>
      <div class="cards-row">
        <ApplicationInfoCard :form="form" :framework-options="frameworkOptions" />
        <GitLabConfigCard
          :form="form"
          :is-authenticated="isAuthenticated"
          :gitlab-context-ready="gitlabContextReady"
          :visibility-options="visibilityOptions"
          :namespace-cache-key="namespaceCacheKey"
        />
      </div>

      <div class="sticky-actions">
        <div class="sticky-actions__hint">
          <strong>准备创建</strong>
          <span>提交前请确认命名、路由前缀和 GitLab Namespace</span>
        </div>
        <a-space class="sticky-actions__buttons">
          <a-button @click="handleReset">重置</a-button>
          <a-button type="primary" :loading="loading" @click="handleCreateClick">创建</a-button>
        </a-space>
      </div>
    </a-form>

    <ScaffoldProgressWorkbench
      v-if="progress.visible"
      v-model:open="progress.visible"
      :loading="loading"
      :progress="progress"
      :form="form"
      @close="handleWorkbenchClose"
      @goto-gitops="handleGotoGitOps"
      @download="handleDownload"
    />
    <GitOpsConfigModal
      v-if="gitopsVisible"
      v-model:open="gitopsVisible"
      :appName="result?.appName || form.appName"
      :appNameZh="result?.appNameZh || form.appNameZh"
      :description="result?.description || form.description"
      :defaultBranch="'dev'"
      :sourceProjectPath="result?.gitlab?.path_with_namespace || ''"
      @success="handleGitOpsSuccess"
      @update:open="handleGitOpsUpdateOpen"
    />
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
