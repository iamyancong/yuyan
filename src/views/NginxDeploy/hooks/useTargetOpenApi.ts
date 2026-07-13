import { computed, ref, type Ref } from 'vue';
import message from 'ant-design-vue/es/message';
import {
  generateTargetOpenApiWithProgress,
  getLatestTargetOpenApi,
  getOpenApiArtifactContent,
  getOpenApiArtifactDownloadUrl,
  getDeployApiAuthHeaders,
  stopTargetDeploy,
  type DeployProgressEvent,
  type DeployTarget,
  type OpenApiArtifact,
} from '@/api/deploy';
import { getErrorMessage, isAbortError, isNotFoundError } from '../utils';

/** OpenAPI Hook 参数 */
interface UseTargetOpenApiParams {
  ensureLoggedIn: () => boolean;
  authState: Readonly<Ref<{ token?: string | null }>>;
}

/**
 * 管理后端目标 OpenAPI 的缓存读取、生成、预览和下载。
 * @param params 认证依赖
 * @returns OpenAPI 抽屉状态和操作方法
 */
export function useTargetOpenApi(params: UseTargetOpenApiParams) {
  const drawerOpen = ref(false);
  const activeTarget = ref<DeployTarget | null>(null);
  const artifact = ref<OpenApiArtifact | null>(null);
  const content = ref('');
  const loading = ref(false);
  const generating = ref(false);
  const errorMessage = ref('');
  const events = ref<DeployProgressEvent[]>([]);
  let abortController: AbortController | null = null;

  /** 当前生成进度 */
  const percent = computed(() => {
    const stage = [...events.value].reverse().find((event) => event.type === 'stage');
    return stage?.type === 'stage' ? stage.percent : generating.value ? 2 : artifact.value ? 100 : 0;
  });

  /** 当前阶段说明 */
  const stageText = computed(() => {
    const stage = [...events.value].reverse().find((event) => event.type === 'stage');
    return stage?.type === 'stage' ? stage.message : generating.value ? '准备生成 OpenAPI' : '';
  });

  /** 生成日志文本 */
  const logContent = computed(() => events.value
    .filter((event) => event.type === 'log' || event.type === 'error')
    .map((event) => {
      if (event.type === 'log') return `[${event.level.toUpperCase()}] ${event.message}`;
      if (event.type === 'error') return `[ERROR] ${event.message}`;
      return '';
    })
    .filter(Boolean)
    .join('\n'));

  /** 读取指定产物内容。 */
  const loadArtifact = async (nextArtifact: OpenApiArtifact) => {
    artifact.value = nextArtifact;
    content.value = await getOpenApiArtifactContent(nextArtifact.id);
  };

  /**
   * 生成 OpenAPI。
   * @param force 是否忽略当前 commit 缓存
   * @param silent 是否静默校验当前分支 commit
   */
  const generateOpenApi = async (force = true, silent = false) => {
    const target = activeTarget.value;
    if (!target || generating.value) return;
    abortController = new AbortController();
    generating.value = true;
    errorMessage.value = '';
    events.value = [];
    try {
      const result = await generateTargetOpenApiWithProgress(
        target.id,
        {
          branch: target.defaultBranch,
          force,
          gitlabToken: String(params.authState.value.token || ''),
        },
        {
          signal: abortController.signal,
          onEvent: (event) => events.value.push(event),
        }
      );
      await loadArtifact(result);
      if (!silent) message.success('OpenAPI 生成完成');
    } catch (error: any) {
      if (isAbortError(error) || abortController?.signal.aborted) {
        message.warning('已请求取消 OpenAPI 生成');
      } else {
        errorMessage.value = getErrorMessage(error);
        message.error(errorMessage.value);
      }
    } finally {
      generating.value = false;
      abortController = null;
    }
  };

  /**
   * 打开后端目标 OpenAPI 抽屉。
   * @param target 后端部署目标
   */
  const openOpenApi = async (target: DeployTarget) => {
    if (!params.ensureLoggedIn()) return;
    activeTarget.value = target;
    artifact.value = null;
    content.value = '';
    events.value = [];
    errorMessage.value = '';
    drawerOpen.value = true;
    loading.value = true;
    try {
      const cached = await getLatestTargetOpenApi(target.id, target.defaultBranch);
      await loadArtifact(cached);
      void generateOpenApi(false, true);
    } catch (error: any) {
      if (isNotFoundError(error)) {
        void generateOpenApi(false);
      } else {
        errorMessage.value = getErrorMessage(error);
      }
    } finally {
      loading.value = false;
    }
  };

  /** 请求取消当前 OpenAPI 任务。 */
  const cancelOpenApi = async () => {
    const targetId = activeTarget.value?.id;
    abortController?.abort();
    if (!targetId) return;
    await stopTargetDeploy(targetId).catch(() => undefined);
  };

  /** 下载当前 OpenAPI 文件。 */
  const downloadOpenApi = async () => {
    if (!artifact.value) return;
    try {
      const response = await fetch(getOpenApiArtifactDownloadUrl(artifact.value.id), { headers: getDeployApiAuthHeaders() });
      if (!response.ok) throw new Error((await response.text()) || '下载失败');
      const blobUrl = window.URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = artifact.value.fileName;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => window.URL.revokeObjectURL(blobUrl), 1000);
      message.success('下载已开始');
    } catch (error: any) {
      message.error(getErrorMessage(error));
    }
  };

  return {
    drawerOpen,
    activeTarget,
    artifact,
    content,
    loading,
    generating,
    errorMessage,
    percent,
    stageText,
    logContent,
    openOpenApi,
    generateOpenApi,
    cancelOpenApi,
    downloadOpenApi,
  };
}
