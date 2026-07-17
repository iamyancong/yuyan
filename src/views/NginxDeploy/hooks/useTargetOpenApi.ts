import { computed, ref, type Ref } from 'vue';
import message from 'ant-design-vue/es/message';
import { Modal } from 'ant-design-vue';
import axios from 'axios';
import {
  generateTargetOpenApiWithProgress,
  getLatestTargetOpenApi,
  getOpenApiArtifactContent,
  getOpenApiArtifactDownloadUrl,
  getDeployApiAuthHeaders,
  scanLocalDeployJdks,
  stopTargetDeploy,
  updateLocalDeployTarget,
  type BuildJdk,
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
 * 从 Java 别名或版本文本提取主版本。
 * @param value Java 别名、版本或 JDK 名称
 * @returns Java 主版本；无法识别时返回 0
 */
const parseJavaMajor = (value?: string): number => {
  const text = String(value || '').trim();
  const legacyMatch = text.match(/\b1\.(\d+)\b/);
  if (legacyMatch) return Number(legacyMatch[1]) || 0;
  return Number(text.match(/\b(\d{1,2})\b/)?.[1] || 0);
};

/**
 * 从扫描结果中选择与目标要求匹配的本机构建 JDK。
 * @param jdks 本机 JDK 扫描结果
 * @param requiredAlias 目标要求的 Java 别名或版本
 * @returns 匹配且检测通过的 JDK
 */
const findLocalBuildJdk = (jdks: BuildJdk[], requiredAlias?: string): BuildJdk | undefined => {
  const availableJdks = jdks.filter((jdk) => jdk.status === 'available' && Number(jdk.majorVersion) > 0);
  const normalizedAlias = String(requiredAlias || '').trim().toLowerCase();
  const exactName = availableJdks.find((jdk) => jdk.name.trim().toLowerCase() === normalizedAlias);
  if (exactName) return exactName;
  const requiredMajor = parseJavaMajor(requiredAlias);
  return requiredMajor ? availableJdks.find((jdk) => Number(jdk.majorVersion) === requiredMajor) : undefined;
};

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

  /** 尝试从测试环境同步此项目的 OpenAPI 配置 */
  const trySyncTargetOpenApiFromTestEnv = async (target: DeployTarget): Promise<boolean> => {
    const testDbUrl = import.meta.env.VITE_TEST_DB_SERVER_URL;
    const testToken = import.meta.env.VITE_DEPLOY_API_TOKEN;
    if (!testDbUrl) return false;

    try {
      const testDbOrigin = new URL(testDbUrl).origin;
      // 避免重复请求自己
      if (window.location.origin === testDbOrigin) return false;

      const url = `${testDbUrl.replace(/\/$/, '')}/deploy-api/targets/${target.id}`;
      const headers: Record<string, string> = {};
      if (testToken) {
        headers['x-deploy-token'] = testToken;
      }

      const response = await axios.get(url, { headers, timeout: 3000 });
      if (response.data?.success && response.data?.data) {
        const remoteTarget = response.data.data;
        if (remoteTarget.openapiCommand && remoteTarget.openapiOutputPath) {
          return new Promise<boolean>((resolve) => {
            Modal.confirm({
              title: '配置未同步提示',
              content: '检测到您本地尚未配置该目标的 OpenAPI 生成信息，但测试环境已配置。是否一键同步测试环境配置到本地并重新生成？',
              okText: '一键同步并生成',
              cancelText: '取消',
              onOk: async () => {
                try {
                  const requiredAlias = String(
                    remoteTarget.requiredJdkAlias
                    || target.requiredJdkAlias
                    || remoteTarget.runtimeJavaVersion
                    || target.runtimeJavaVersion
                    || ''
                  ).trim();
                  const localJdks = await scanLocalDeployJdks();
                  const matchedJdk = findLocalBuildJdk(localJdks, requiredAlias);
                  if (!matchedJdk) {
                    const requiredMajor = parseJavaMajor(requiredAlias);
                    throw new Error(`本机未检测到可用的 Java ${requiredMajor || requiredAlias || '构建'} JDK，请先安装对应版本`);
                  }
                  const payload = {
                    ...target,
                    openapiCommand: remoteTarget.openapiCommand,
                    openapiOutputPath: remoteTarget.openapiOutputPath,
                    buildJdkId: matchedJdk.id,
                    jdkId: matchedJdk.id,
                    requiredJdkAlias: String(matchedJdk.majorVersion),
                  } as any;
                  const updated = await updateLocalDeployTarget(target.id, payload);
                  activeTarget.value = updated;
                  message.success(`配置同步成功，已自动绑定 ${matchedJdk.name}`);
                  resolve(true);
                } catch (err: any) {
                  message.error('同步配置到本地失败: ' + (err.message || err));
                  resolve(false);
                }
              },
              onCancel: () => {
                resolve(false);
              },
            });
          });
        }
      }
    } catch (err) {
      console.warn('[trySyncTargetOpenApiFromTestEnv] 请求测试环境配置失败:', err);
    }
    return false;
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
        const errorMsg = getErrorMessage(error);
        if (errorMsg.includes('请先配置 OpenAPI 生成命令和输出路径')) {
          const synced = await trySyncTargetOpenApiFromTestEnv(target);
          if (synced) {
            generating.value = false;
            abortController = null;
            void generateOpenApi(force, silent);
            return;
          }
        }
        errorMessage.value = errorMsg;
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
    await stopTargetDeploy(targetId, 'backend').catch(() => undefined);
  };

  /** 下载当前 OpenAPI 文件。 */
  const downloadOpenApi = async () => {
    if (!artifact.value) return;
    try {
      const response = await fetch(await getOpenApiArtifactDownloadUrl(artifact.value.id), { headers: getDeployApiAuthHeaders() });
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
