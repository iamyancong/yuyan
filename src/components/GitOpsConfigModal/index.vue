<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { useGitOpsNaming } from './hooks/useGitOpsNaming';
import { useCiImageRepo } from './hooks/useCiImageRepo';
import { useTemplateReplace } from './hooks/useTemplateReplace';
import { useGitOpsForm } from './hooks/useGitOpsForm';
import BasicConfigCard from './components/BasicConfigCard.vue';
import FilePreviewCard from './components/FilePreviewCard.vue';
import MRInfoPanel from './components/MRInfoPanel.vue';

defineOptions({ name: 'GitOpsConfigModal' });

/** 属性定义 */
const props = defineProps<{
  open: boolean;
  appName?: string;
  appNameZh?: string;
  description?: string;
  gitopsProjectPath?: string;
  templateDir?: string;
  defaultBranch?: string;
  sourceProjectPath?: string;
  sourceProjectId?: number;
}>();

/** 事件定义 */
const emit = defineEmits<{
  (e: 'update:open', v: boolean): void;
  (e: 'success'): void;
}>();

// http://192.168.167.142:8081/Data-Middleground-Develop-Area/product-code/web/vue/basic-component/yss-datamiddle-gitops.git
/** 计算默认值 */
const V_GITOPS_PROJECT_PATH = computed(
  () => props.gitopsProjectPath || 'Data-Middleground-Develop-Area/product-code/web/vue/basic-component/yss-datamiddle-gitops'
);
const V_DEFAULT_BRANCH = computed(() => props.defaultBranch || 'dev');
const V_APP_NAME_ZH = computed(() => (props.appNameZh || '').trim());
const V_DESCRIPTION = computed(() => (props.description || '').trim());
const V_SOURCE_PROJECT_PATH = computed(() => (props.sourceProjectPath || '').trim());

/** 可见性绑定 */
const visible = computed({
  get: () => props.open,
  set: (v) => emit('update:open', v),
});

/** 命名与路径 */
const customDirName = ref<string>('');
const appNameRef = computed(() => props.appName || '');
const {
  appNameRaw,
  appSlugHyphen,
  frontendDirName,
  effectiveDirName,
  targetDirPrefix,
  buildK8sBaseId,
  buildK8sNameWithSuffix,
  setDefaultCustomDirName,
  sanitizeCustomDirName,
} = useGitOpsNaming(appNameRef, customDirName);

/**
 * 动态计算模板目录
 */
const templateDirResolved = computed(() => {
  const customDir = (customDirName.value && customDirName.value.trim()) || '';
  if (customDir) {
    const sanitized = sanitizeCustomDirName(customDir);
    const existsInOptions = formState.dirOptions.value.includes(sanitized);
    if (existsInOptions) {
      return `${sanitized}/.deployments`;
    } else {
      return props.templateDir || 'yss-datamiddle-frontend-data-quality/.deployments';
    }
  }
  return props.templateDir || 'yss-datamiddle-frontend-data-quality/.deployments';
});

const aliasPreferred = computed(() => (V_APP_NAME_ZH.value || V_DESCRIPTION.value || appNameRaw.value || '').trim());

/** 镜像仓库 */
const { sourceImageRepo, resolveFromProjectPath } = useCiImageRepo();

/** 包装 resolveFromProjectPath为 void 返回类型 */
const resolveFromProjectPathVoid = async (projectPath: string, branch: string): Promise<void> => {
  await resolveFromProjectPath(projectPath, branch);
};

/** 模板替换 */
const { computeTargetPath, applyReplacements } = useTemplateReplace({ buildK8sBaseId, buildK8sNameWithSuffix });

/** 表单状态管理 */
const formState = useGitOpsForm({
  gitopsProjectPath: V_GITOPS_PROJECT_PATH,
  defaultBranch: V_DEFAULT_BRANCH,
  sourceProjectPath: V_SOURCE_PROJECT_PATH,
  templateDirResolved,
  frontendDirName,
  targetDirPrefix,
  appSlugHyphen,
  aliasPreferred,
  sourceImageRepo,
  customDirName,
  computeTargetPath,
  applyReplacements,
  resolveFromProjectPath: resolveFromProjectPathVoid,
  sanitizeCustomDirName,
});

/** 防止重复触发加载的标志 */
let hasCustomDirInteracted = false;

/** 处理分支变更 */
const onBranchChange = () => {
  if (!formState.ready.value) return;
  if (visible.value) void formState.loadAll();
};

/** 处理提交成功 */
const handleSuccess = () => {
  emit('success');
  visible.value = false;
};

/** 监听抽屉打开/关闭 */
watch(
  () => visible.value,
  (v) => {
    if (v) {
      setDefaultCustomDirName();
      formState.reset();
      formState.loadAll();
    }
  }
);

/** 监听自定义目录名变更 */
watch(
  () => customDirName.value,
  (v, o) => {
    if (!visible.value) return;
    if (!hasCustomDirInteracted) {
      hasCustomDirInteracted = true;
      return;
    }
    if (v !== o) {
      const sanitized = sanitizeCustomDirName(v || '');
      if (sanitized !== v) {
        customDirName.value = sanitized;
        return;
      }
      void formState.loadAll();
    }
  }
);

/** 组件挂载 */
onMounted(() => {
  if (visible.value) formState.loadAll();
});

/** 更新当前文件编辑内容 */
const updateEditedContent = (value: string) => {
  if (formState.files.value[formState.activeIndex.value]) {
    formState.files.value[formState.activeIndex.value].editedContent = value;
  }
};
</script>

<template>
  <a-drawer
    v-model:open="visible"
    :title="formState.mode.value === 'create' ? '配置 GitOps（新建）' : '配置 GitOps（更新）'"
    width="70%"
    placement="right"
    @close="visible = false"
    destroyOnClose
  >
    <a-spin :spinning="formState.loading.value">
      <!-- 基础配置卡片 -->
      <BasicConfigCard
        :branches="formState.branches.value"
        v-model:selectedBranch="formState.selectedBranch.value"
        :dirOptions="formState.dirOptions.value"
        v-model:customDirName="customDirName"
        :suggestedDir="formState.suggestedDir.value"
        v-model:useMergeRequest="formState.useMergeRequest.value"
        v-model:newBranchName="formState.newBranchName.value"
        @branch-change="onBranchChange"
      />

      <!-- MR 信息折叠面板（仅 MR 模式显示）-->
      <MRInfoPanel
        v-if="formState.useMergeRequest.value"
        v-model:mrTitle="formState.mrTitle.value"
        v-model:mrDescription="formState.mrDescription.value"
        style="margin-bottom: 12px"
      />

      <!-- 文件预览卡片 -->
      <FilePreviewCard
        v-if="formState.files.value.length"
        :files="formState.files.value"
        v-model:activeIndex="formState.activeIndex.value"
        :mode="formState.mode.value"
        @update:edited-content="updateEditedContent"
      />

      <!-- 错误提示 -->
      <a-empty v-else-if="formState.loadError.value" class="error-empty" :description="formState.loadError.value">
        <template #image>
          <a-result status="warning" />
        </template>
        <a-typography-paragraph type="secondary" style="margin-bottom: 8px">可能的解决方案：</a-typography-paragraph>
        <ul class="error-empty-solutions">
          <li>检查所选目录是否包含 .deployments 子目录</li>
          <li>切换到其他分支或选择已有的目录名</li>
          <li>如需创建新目录，请先在 GitLab 中创建相应的模板结构</li>
          <li>联系管理员确认模板目录配置是否正确</li>
        </ul>
      </a-empty>

      <!-- 加载中 -->
      <a-empty v-else description="正在加载模板文件..." />
    </a-spin>

    <!-- 底部按钮组 -->
    <template #footer>
      <div class="drawer-footer">
        <div class="drawer-footer-left">
          <a-button :disabled="!formState.canDownload.value" @click="formState.downloadYaml"> 下载 k8s-deployments-service.yml </a-button>
        </div>
        <div class="drawer-footer-right">
          <a-button @click="visible = false">取消</a-button>
          <a-button type="primary" :loading="formState.loading.value" :disabled="!appNameRaw" @click="formState.handleSubmit(handleSuccess)">
            {{ formState.useMergeRequest.value ? '创建 MR' : '直接推送代码' }}
          </a-button>
        </div>
      </div>
    </template>
  </a-drawer>
</template>
<style scoped lang="less">
@import './style.less';
</style>
