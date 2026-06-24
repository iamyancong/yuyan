import { computed, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import type { CreateMicroAppResponse } from '@/api/scaffold';

export type ProgressStatus = 'idle' | 'running' | 'success' | 'error';

export interface StageItem {
  key: string;
  title: string;
  description: string;
  percent: number;
  status: 'wait' | 'process' | 'finish' | 'error';
}

export interface ProgressState {
  visible: boolean;
  status: ProgressStatus;
  percent: number;
  currentStageKey: string;
  currentStageTitle: string;
  currentMessage: string;
  errorMessage: string;
  elapsedText: string;
  createRepo: boolean;
  stages: StageItem[];
  logs: unknown[];
  result: CreateMicroAppResponse['data'] | null;
}

export interface ScaffoldFormSnapshot {
  appName: string;
  appNameZh: string;
  port: number;
  activeRule: string;
  apiBase: string;
  proxyTarget: string;
  description?: string;
  createRepo?: boolean;
  gitlabHost?: string;
  gitlabToken?: string;
  namespaceId?: string;
  visibility?: string;
  framework?: string;
}

export interface ScaffoldProgressWorkbenchProps {
  open: boolean;
  loading: boolean;
  progress: ProgressState;
  form: ScaffoldFormSnapshot;
}

type ScaffoldProgressWorkbenchEmit = {
  (e: 'update:open', value: boolean): void;
  (e: 'goto-gitops'): void;
  (e: 'download'): void;
  (e: 'close'): void;
};

export interface ScaffoldProgressSnapshot {
  appName: string;
  appNameZh: string;
  activeRule: string;
  standaloneBase: string;
  apiBase: string;
  proxyTarget: string;
  description: string;
  downloadPath: string;
  gitlabWebUrl: string;
  gitlabHttpUrl: string;
  gitlabPath: string;
  label: string;
  configFile: string;
  configCode: string;
}

const truncateMiddle = (value: string, head = 36, tail = 18) => {
  if (!value) return '';
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
};

const summarizeErrorMessage = (value: string) => {
  if (!value) return '';
  const summary = value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean) || '';
  const normalized = summary.replace(/^(error|err):\s*/i, '');
  if (normalized.length <= 88) return normalized;
  return `${normalized.slice(0, 88).trimEnd()}...`;
};

export const useScaffoldProgressWorkbench = (
  props: ScaffoldProgressWorkbenchProps,
  emit: ScaffoldProgressWorkbenchEmit
) => {
  const visible = computed({
    get: () => props.open,
    set: (value: boolean) => emit('update:open', value),
  });

  const statusText = computed(() => {
    switch (props.progress.status) {
      case 'running':
        return '创建中';
      case 'success':
        return '已完成';
      case 'error':
        return '失败';
      default:
        return '待开始';
    }
  });

  const statusTagColor = computed(() => {
    switch (props.progress.status) {
      case 'running':
        return 'processing';
      case 'success':
        return 'success';
      case 'error':
        return 'error';
      default:
        return 'default';
    }
  });

  const snapshot = computed<ScaffoldProgressSnapshot>(() => {
    const result = props.progress.result || {};
    const gitlab = (result as CreateMicroAppResponse['data'])?.gitlab || null;

    const appName = (result as CreateMicroAppResponse['data'])?.appName || props.form.appName;
    const appNameZh = (result as CreateMicroAppResponse['data'])?.appNameZh || props.form.appNameZh;
    const activeRule = (result as CreateMicroAppResponse['data'])?.activeRule || props.form.activeRule;
    const standaloneBase = (result as CreateMicroAppResponse['data'])?.standaloneBase || '/';
    const apiBase = (result as CreateMicroAppResponse['data'])?.apiBase || props.form.apiBase;
    const proxyTarget = (result as CreateMicroAppResponse['data'])?.proxyTarget || props.form.proxyTarget;
    const description = (result as CreateMicroAppResponse['data'])?.description || props.form.description || '-';
    const downloadPath = (result as CreateMicroAppResponse['data'])?.downloadPath || '';

    return {
      appName,
      appNameZh,
      activeRule,
      standaloneBase,
      apiBase,
      proxyTarget,
      description,
      downloadPath,
      gitlabWebUrl: gitlab?.webUrl || '',
      gitlabHttpUrl: gitlab?.httpUrl || '',
      gitlabPath: gitlab?.path_with_namespace || '',
      label: `${appNameZh} (${appName})`,
      configFile: 'packages/mainapp/src/config/microApps.ts',
      configCode: `const microAppsMinimalVue3: MicroAppMinimalConfig[] = [
  {
    name: '${appName}',
    flag: 'micro',
    devUrl: '${props.form.port}',
    styleIsolation: 'none',
  },
];`,
    };
  });

  const showGitlabUrlFull = computed(() => props.progress.status === 'success' || props.progress.status === 'error');
  const codeExpanded = ref(props.progress.status === 'success');
  const modeText = computed(() => (props.progress.createRepo ? 'GitLab 模式' : '下载模式'));
  const isDownloadSuccessHero = computed(() => !props.progress.createRepo && props.progress.status === 'success');
  const isGitlabSuccessHero = computed(
    () => props.progress.createRepo && props.progress.status === 'success' && !!snapshot.value.gitlabWebUrl
  );
  const isGitlabErrorHero = computed(() => props.progress.createRepo && props.progress.status === 'error');
  const heroErrorSummary = computed(() => summarizeErrorMessage(props.progress.errorMessage || props.progress.currentMessage));
  const showAccessSection = computed(() => props.progress.createRepo && !!(snapshot.value.gitlabWebUrl || snapshot.value.gitlabPath));
  const heroTitle = computed(() => {
    if (isDownloadSuccessHero.value) return '项目创建完成';
    if (isGitlabSuccessHero.value) return '仓库已创建完成';
    if (props.progress.status === 'error') return '创建失败';
    return props.progress.currentStageTitle;
  });
  const heroDescription = computed(() => {
    if (isDownloadSuccessHero.value) return '项目文件已准备完成，可直接下载并接入主应用配置。';
    if (isGitlabSuccessHero.value) return '仓库入口已生成，可以直接跳转到 GitLab 继续查看和协作。';
    if (props.progress.status === 'error') {
      return props.progress.createRepo ? '仓库创建或推送失败，请查看下方错误详情。' : '项目创建失败，请查看下方错误详情。';
    }
    return props.progress.currentMessage;
  });
  const heroGitlabText = computed(() => (isGitlabSuccessHero.value ? 'GitLab 仓库已就绪' : ''));
  const heroGitlabUrlShort = computed(() => {
    if (!isGitlabSuccessHero.value) return '';
    return snapshot.value.gitlabPath || truncateMiddle(snapshot.value.gitlabWebUrl);
  });

  watch(
    () => [props.open, props.progress.status] as const,
    ([open, status]) => {
      if (!open) {
        codeExpanded.value = false;
        return;
      }

      if (status === 'success' || status === 'error') {
        codeExpanded.value = true;
      }
    },
    { immediate: true }
  );

  const stageStatusLabel = (status: StageItem['status']) => {
    switch (status) {
      case 'process':
        return '进行中';
      case 'finish':
        return '完成';
      case 'error':
        return '失败';
      default:
        return '等待';
    }
  };

  const copyText = async (text: string, label: string) => {
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      message.success(`${label}已复制`);
    } catch {
      message.error(`${label}复制失败`);
    }
  };

  const openGitlab = () => {
    if (!snapshot.value.gitlabWebUrl) return;
    window.open(snapshot.value.gitlabWebUrl, '_blank', 'noopener,noreferrer');
  };

  const handleClose = () => {
    emit('close');
    visible.value = false;
  };

  return {
    visible,
    statusText,
    statusTagColor,
    snapshot,
    showGitlabUrlFull,
    codeExpanded,
    modeText,
    isDownloadSuccessHero,
    isGitlabSuccessHero,
    isGitlabErrorHero,
    heroErrorSummary,
    showAccessSection,
    heroTitle,
    heroDescription,
    heroGitlabText,
    heroGitlabUrlShort,
    stageStatusLabel,
    copyText,
    openGitlab,
    handleClose,
  };
};
