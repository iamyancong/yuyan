<script setup lang="ts">
import { computed } from 'vue';
import { YButton, YMonaco } from '@ycwang-dev/components/lite';
import { LinkOutlined } from '@ant-design/icons-vue';
import type { DeployTarget, OpenApiArtifact } from '@/api/deploy';
import { OPENAPI_JSON_LANGUAGE } from '@/utils/monacoJsonHighlight';
import { formatDeployDateTime } from '../../constant';
import { useOpenApiMonacoHighlight } from './hooks/useOpenApiMonacoHighlight';
import { openExternal } from '@/utils/open';
import { getGitLabHost } from '@/api/gitlab';

defineOptions({ name: 'OpenApiDrawer' });

/** OpenAPI 抽屉属性 */
interface OpenApiDrawerProps {
  open: boolean;
  target: DeployTarget | null;
  artifact: OpenApiArtifact | null;
  content: string;
  loading: boolean;
  generating: boolean;
  errorMessage: string;
  percent: number;
  stageText: string;
  logContent: string;
}

const props = defineProps<OpenApiDrawerProps>();
const { monacoRef } = useOpenApiMonacoHighlight(() => props.content);
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'generate'): void;
  (e: 'cancel'): void;
  (e: 'download'): void;
}>();

/** 抽屉双向绑定状态 */
const drawerOpen = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
});

/** 获取 Commit 详情的 GitLab 链接 */
const commitUrl = computed(() => {
  const commitSha = props.artifact?.commitSha || '';
  if (!commitSha) return '';

  const gitlabHost = getGitLabHost();
  const host = gitlabHost.replace(/\/+$/, '').replace(/\/api\/v4$/, '');
  const projectPath = props.target?.projectPath || '';

  if (projectPath) {
    return `${host}/${projectPath}/-/commit/${commitSha}`;
  }

  const repoUrl = props.target?.repositoryUrl || '';
  if (repoUrl) {
    if (repoUrl.startsWith('http://') || repoUrl.startsWith('https://')) {
      const baseUrl = repoUrl.replace(/\.git$/i, '');
      return `${baseUrl}/-/commit/${commitSha}`;
    }
    if (repoUrl.includes('@')) {
      const match = repoUrl.match(/@([^:/]+)(?::\d+)?[:/](.+)$/i);
      if (match) {
        const hostName = match[1];
        const repoPath = match[2].replace(/\.git$/i, '');
        let portPart = '';
        try {
          const urlObj = new URL(host);
          if (urlObj.port) portPart = `:${urlObj.port}`;
        } catch (e) {}
        return `${host.startsWith('https') ? 'https' : 'http'}://${hostName}${portPart}/${repoPath}/-/commit/${commitSha}`;
      }
    }
  }

  return '';
});

/** 文件大小展示值 */
const fileSizeText = computed(() => {
  const size = Number(props.artifact?.sizeBytes || 0);
  if (!size) return '-';
  return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(2)} MB` : `${(size / 1024).toFixed(1)} KB`;
});
</script>

<template>
  <a-drawer
    v-model:open="drawerOpen"
    title="OpenAPI 预览"
    width="min(92vw, 1200px)"
    placement="right"
    destroyOnClose
    class="openapi-drawer"
    :maskClosable="!generating"
  >
    <a-spin :spinning="loading" tip="正在读取 OpenAPI 缓存...">
      <div class="openapi-summary">
        <div><span>项目</span><strong>{{ target?.projectName || '-' }}</strong></div>
        <div><span>分支</span><strong>{{ artifact?.branch || target?.defaultBranch || '-' }}</strong></div>
        <div>
          <span>Commit</span>
          <a
            v-if="commitUrl"
            :href="commitUrl"
            class="openapi-commit-link"
            @click.prevent.stop="openExternal(commitUrl)"
            title="在 GitLab 查看提交详情"
          >
            {{ artifact?.commitSha?.slice(0, 12) }}
            <link-outlined class="openapi-commit-link__icon" />
          </a>
          <strong v-else>{{ artifact?.commitSha?.slice(0, 12) || '-' }}</strong>
        </div>
        <div><span>生成时间</span><strong>{{ artifact ? formatDeployDateTime(artifact.generatedAt) : '-' }}</strong></div>
        <div><span>文件大小</span><strong>{{ fileSizeText }}</strong></div>
      </div>

      <a-alert v-if="errorMessage" type="error" show-icon :message="errorMessage" class="openapi-alert" />
      <Transition name="fade-slide" mode="out-in">
        <div v-if="generating" key="progress" class="openapi-progress">
          <div class="openapi-progress__heading">
            <strong>{{ stageText }}</strong>
            <span>{{ percent }}%</span>
          </div>
          <a-progress :percent="percent" :show-info="false" size="small" />
          <YMonaco
            v-if="logContent"
            :model-value="logContent"
            language="log"
            theme="vs-dark"
            height="calc(100vh - 310px)"
            :readonly="true"
            log-mode
            :auto-scroll="true"
            :auto-layout="true"
            :options="{ minimap: { enabled: false }, fontSize: 12, wordWrap: 'on', readOnly: true }"
          />
        </div>

        <YMonaco
          v-else-if="content"
          ref="monacoRef"
          key="content"
          :model-value="content"
          :language="OPENAPI_JSON_LANGUAGE"
          theme="vs-dark"
          height="calc(100vh - 225px)"
          :readonly="true"
          :format-on-mount="false"
          :toolbar-options="{ copy: true, fullscreen: true, download: false }"
          :auto-layout="true"
          :options="{ minimap: { enabled: false }, fontSize: 13, wordWrap: 'off', readOnly: true }"
        />
        <a-empty v-else-if="!loading && !errorMessage" key="empty" description="暂无 OpenAPI 产物" />
      </Transition>
    </a-spin>

    <template #footer>
      <div class="openapi-footer">
        <span>生成失败不会覆盖上一次成功产物，单文件最大 20MB。</span>
        <a-space>
          <YButton v-if="generating" danger @click="emit('cancel')">取消生成</YButton>
          <YButton :disabled="generating || loading" @click="emit('generate')">重新生成</YButton>
          <YButton type="primary" :disabled="!artifact || !content || generating" @click="emit('download')">下载文件</YButton>
        </a-space>
      </div>
    </template>
  </a-drawer>
</template>

<style scoped lang="less">
@import './style.less';
</style>
