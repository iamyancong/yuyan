import { reactive, ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { message } from 'ant-design-vue';
import type { FormInstance } from 'ant-design-vue';
import { createMicroAppWithProgress, type CreateMicroAppPayload, type ScaffoldProgressEvent } from '@/api/scaffold';
import { useAuth } from '@/composables/useAuth';

type ScaffoldStageKey = 'validate' | 'pull-template' | 'generate' | 'install-sync-skills' | 'gitlab-create-push' | 'package-download' | 'finalize';
type ScaffoldStageStatus = 'wait' | 'process' | 'finish' | 'error';
type ScaffoldLogLevel = 'info' | 'success' | 'warn' | 'error';

interface ScaffoldStageItem {
  key: ScaffoldStageKey;
  title: string;
  description: string;
  percent: number;
  status: ScaffoldStageStatus;
}

interface ScaffoldLogItem {
  id: number;
  level: ScaffoldLogLevel;
  message: string;
  stage: string;
  timestamp: string;
}

const formatDuration = (ms: number) => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
};

const buildProgressStages = (createRepo: boolean): ScaffoldStageItem[] => {
  const stages: ScaffoldStageItem[] = [
    { key: 'validate', title: '参数校验', description: '检查命名、路由与 GitLab 配置', percent: 5, status: 'wait' },
    { key: 'pull-template', title: '拉取模板', description: '同步最新模板仓库', percent: 18, status: 'wait' },
    { key: 'generate', title: '生成项目', description: '写入项目骨架与配置文件', percent: 42, status: 'wait' },
    {
      key: 'install-sync-skills',
      title: 'Node 同步 skills',
      description: '直接调用本地 skills-cli 写入 .agent/skills',
      percent: 72,
      status: 'wait',
    },
  ];

  if (createRepo) {
    stages.push({ key: 'gitlab-create-push', title: 'GitLab 创建 / 推送', description: '创建远程仓库并推送代码', percent: 92, status: 'wait' });
  } else {
    stages.push({ key: 'package-download', title: '下载包准备', description: '生成压缩包下载入口', percent: 92, status: 'wait' });
  }

  stages.push({ key: 'finalize', title: '完成收口', description: '整理结果与下一步操作', percent: 100, status: 'wait' });
  return stages;
};

export function useScaffold() {
  const result = ref<any>(null);
  const formRef = ref<FormInstance>();
  const progressTimer = ref<number | null>(null);
  let createAbortController: AbortController | null = null;

  const progress = reactive<{
    visible: boolean;
    status: 'idle' | 'running' | 'success' | 'error';
    percent: number;
    currentStageKey: ScaffoldStageKey;
    currentStageTitle: string;
    currentMessage: string;
    errorMessage: string;
    elapsedMs: number;
    elapsedText: string;
    createRepo: boolean;
    stages: ScaffoldStageItem[];
    logs: ScaffoldLogItem[];
    result: any;
  }>({
    visible: false,
    status: 'idle',
    percent: 0,
    currentStageKey: 'validate',
    currentStageTitle: '准备创建',
    currentMessage: '请选择配置后开始创建',
    errorMessage: '',
    elapsedMs: 0,
    elapsedText: '00:00',
    createRepo: true,
    stages: buildProgressStages(true),
    logs: [],
    result: null,
  });
  const loading = computed(() => progress.status === 'running');

  // 集成认证状态
  const { isLoggedIn, authState } = useAuth();

  const visibilityOptions = [
    { label: 'private', value: 'private' },
    { label: 'internal', value: 'internal' },
    { label: 'public', value: 'public' },
  ];

  const form = reactive<CreateMicroAppPayload & { gitlabToken: string }>({
    appName: '',
    appNameZh: '',
    port: 8081,
    activeRule: '',
    apiBase: '/api',
    proxyTarget: import.meta.env.VITE_DEFAULT_PROXY_TARGET || 'http://localhost:3000',
    description: '',
    createRepo: true,
    gitlabHost: import.meta.env.VITE_GITLAB_HOST || '',
    gitlabToken: '',
    namespaceId: '2088',
    visibility: 'private',
    framework: 'vue3',
  });

  const stopProgressTimer = () => {
    if (progressTimer.value !== null) {
      window.clearInterval(progressTimer.value);
      progressTimer.value = null;
    }
  };

  /**
   * 中断当前脚手架创建请求。
   */
  const abortCreateRequest = () => {
    if (!createAbortController) return;
    createAbortController.abort();
    createAbortController = null;
  };

  const startProgressTimer = () => {
    stopProgressTimer();
    progressTimer.value = window.setInterval(() => {
      if (progress.status !== 'running') return;
      progress.elapsedMs += 250;
      progress.elapsedText = formatDuration(progress.elapsedMs);
    }, 250);
  };

  const appendLog = (level: ScaffoldLogLevel, messageText: string, stage = '') => {
    progress.logs.push({
      id: Date.now() + Math.floor(Math.random() * 1000),
      level,
      message: messageText,
      stage,
      timestamp: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    });

    if (progress.logs.length > 120) {
      progress.logs.splice(0, progress.logs.length - 120);
    }
  };

  const setCurrentStage = (stageKey: ScaffoldStageKey, percent: number, messageText: string) => {
    progress.currentStageKey = stageKey;
    progress.currentMessage = messageText;
    progress.percent = percent;

    const currentIndex = progress.stages.findIndex((item) => item.key === stageKey);
    progress.stages = progress.stages.map((item, index) => {
      if (currentIndex < 0) return item;
      if (index < currentIndex) {
        return { ...item, status: 'finish' };
      }
      if (index === currentIndex) {
        return { ...item, status: progress.status === 'error' ? 'error' : 'process', percent };
      }
      return { ...item, status: 'wait' };
    });
  };

  const startProgress = (createRepo: boolean) => {
    progress.visible = true;
    progress.status = 'running';
    progress.percent = 0;
    progress.currentStageKey = 'validate';
    progress.currentStageTitle = '参数校验';
    progress.currentMessage = '正在校验表单与权限配置';
    progress.errorMessage = '';
    progress.elapsedMs = 0;
    progress.elapsedText = '00:00';
    progress.createRepo = createRepo;
    progress.stages = buildProgressStages(createRepo);
    progress.logs = [];
    progress.result = null;
    appendLog('info', '开始创建微应用', 'validate');
    startProgressTimer();
  };

  const finishProgress = (stageKey: ScaffoldStageKey, percent: number, messageText: string, level: ScaffoldLogLevel = 'success') => {
    progress.currentStageKey = stageKey;
    progress.currentMessage = messageText;
    progress.percent = percent;
    progress.status = 'success';
    progress.currentStageTitle = progress.stages.find((item) => item.key === stageKey)?.title || '完成';
    progress.stages = progress.stages.map((item, index, list) => {
      const currentIndex = list.findIndex((stage) => stage.key === stageKey);
      if (currentIndex < 0) return { ...item, status: 'finish' };
      if (index <= currentIndex) return { ...item, status: 'finish' };
      return item;
    });
    appendLog(level, messageText, stageKey);
    progress.elapsedText = formatDuration(progress.elapsedMs);
    stopProgressTimer();
  };

  const failProgress = (messageText: string, stageKey: ScaffoldStageKey = progress.currentStageKey) => {
    progress.status = 'error';
    progress.errorMessage = messageText;
    progress.currentStageKey = stageKey;
    progress.currentStageTitle = progress.stages.find((item) => item.key === stageKey)?.title || '创建失败';
    progress.currentMessage = messageText;
    progress.stages = progress.stages.map((item) => {
      if (item.key === stageKey) return { ...item, status: 'error' };
      return item.status === 'wait' ? item : { ...item, status: 'finish' };
    });
    appendLog('error', messageText, stageKey);
    progress.elapsedText = formatDuration(progress.elapsedMs);
    stopProgressTimer();
  };

  const handleProgressEvent = (event: ScaffoldProgressEvent) => {
    if (event.type === 'stage') {
      const stage = progress.stages.find((item) => item.key === event.stage);
      if (stage) {
        progress.currentStageTitle = stage.title;
      }
      setCurrentStage(event.stage as ScaffoldStageKey, event.percent ?? progress.percent, event.detail || event.message);
      appendLog('info', event.message, event.stage);
      return;
    }

    if (event.type === 'log') {
      appendLog((event.level || 'info') as ScaffoldLogLevel, event.message, event.stage || progress.currentStageKey);
      return;
    }

    if (event.type === 'result') {
      result.value = event.data;
      progress.result = event.data;
      finishProgress('finalize', 100, '创建完成，正在整理结果');
      return;
    }

    if (event.type === 'error') {
      failProgress(event.message, (event.stage as ScaffoldStageKey) || progress.currentStageKey);
    }
  };

  // 计算属性：是否已登录且有token（确保为布尔值）
  const isAuthenticated = computed(() => !!(isLoggedIn.value && authState.value.token));

  // 当认证状态改变时，自动填充token和host
  const updateAuthFields = async () => {
    console.log('更新认证字段，当前认证状态:', {
      isLoggedIn: isLoggedIn.value,
      hasToken: !!authState.value.token,
      hasHost: !!authState.value.host,
      isAuthenticated: isAuthenticated.value,
    });

    if (isAuthenticated.value) {
      const newToken = authState.value.token || '';
      const newHost = authState.value.host || form.gitlabHost;

      // 只有当值真正发生变化时才更新，避免不必要的响应式触发
      if (form.gitlabToken !== newToken || form.gitlabHost !== newHost) {
        console.log('更新表单字段:', { newToken, newHost });
        form.gitlabToken = newToken;
        form.gitlabHost = newHost;

        // 强制触发响应式更新
        await nextTick();
      }
    } else {
      // 未登录状态下，清空token但保留host
      if (form.gitlabToken !== '') {
        console.log('清空认证Token');
        form.gitlabToken = '';
        await nextTick();
      }
    }
  };

  onMounted(async () => {
    console.log('组件挂载，初始化认证字段');
    await updateAuthFields();
  });

  // 监听认证状态变化 - 使用更精确的监听
  watch(
    () => isLoggedIn.value,
    async (newLoggedIn, oldLoggedIn) => {
      console.log('登录状态变化:', { oldLoggedIn, newLoggedIn });
      await updateAuthFields();
    }
  );

  // 监听认证状态的token和host变化
  watch(
    () => authState.value.token,
    async (newToken, oldToken) => {
      console.log('认证Token变化:', { oldToken, newToken });
      await updateAuthFields();
    }
  );

  watch(
    () => authState.value.host,
    async (newHost, oldHost) => {
      console.log('认证Host变化:', { oldHost, newHost });
      await updateAuthFields();
    }
  );

  // 监听全局认证状态变化事件
  const handleAuthChange = async (event: CustomEvent) => {
    console.log('收到全局认证状态变化事件:', event.detail);
    await nextTick();
    await updateAuthFields();
  };

  onMounted(() => {
    window.addEventListener('auth-state-changed', handleAuthChange as unknown as EventListener);
  });

  onUnmounted(() => {
    window.removeEventListener('auth-state-changed', handleAuthChange as unknown as EventListener);
    abortCreateRequest();
    stopProgressTimer();
  });

  const kebabCaseRe = /^[a-z]+(-[a-z0-9]+)*$/;
  const chineseNameRe = /^[\u4e00-\u9fa5a-zA-Z0-9\s]+$/;
  // 仅单段路由，必须以一个正斜杠开头；允许"驼峰"或"短横线"两种命名
  // - 驼峰: /dmDataSource
  // - 短横线: /data-service 或 /data-source-v3
  // 不允许: 额外分段(/a)、反斜杠、前后空格、以大写开头等
  const activeRuleRe = /^\/(?:(?:[a-z]+(?:[A-Z][a-z0-9]+)*)|(?:[a-z]+(?:-[a-z0-9]+)*))$/;

  // Ant Design Vue 表单校验规则（change 触发，错误展示在表单项下方）
  const rules = reactive<Record<string, any[]>>({
    appName: [
      { required: true, message: '请输入微应用英文名称', trigger: 'change' },
      {
        trigger: 'change',
        validator: (_: unknown, value: string) => {
          if (!value) return Promise.resolve();
          return kebabCaseRe.test(value)
            ? Promise.resolve()
            : Promise.reject(new Error('微应用英文名称只允许小写字母、数字和中划线，如 data-service'));
        },
      },
    ],
    appNameZh: [
      { required: true, message: '请输入微应用中文名称', trigger: 'change' },
      {
        trigger: 'change',
        validator: (_: unknown, value: string) => {
          if (!value) return Promise.resolve();
          return chineseNameRe.test(value) ? Promise.resolve() : Promise.reject(new Error('微应用中文名称只允许中文、英文、数字和空格'));
        },
      },
    ],
    activeRule: [
      { required: true, message: '请输入激活路由前缀', trigger: 'change' },
      {
        trigger: 'change',
        validator: (_: unknown, value: string) => {
          const v = (value || '').trim();
          return activeRuleRe.test(v)
            ? Promise.resolve()
            : Promise.reject(new Error('激活路由前缀必须以/开头，且为单段路径；如 /dmDataSource、/data-service、/data-source-v3'));
        },
      },
    ],
  });

  const validateAppName = () => {
    return kebabCaseRe.test(form.appName);
  };

  const validateActiveRule = () => {
    const value = (form.activeRule || '').trim();
    return activeRuleRe.test(value);
  };

  // 同步 apiBase: 默认始终为 /api + activeRule（初始化及变更时）
  watch(
    () => form.activeRule,
    (newRule) => {
      const v = (newRule || '').trim();
      form.apiBase = `/api${v}`;
    },
    { immediate: true }
  );

  const handleReset = () => {
    abortCreateRequest();
    // 重置时，如果用户已登录，保留认证信息
    const currentToken = isAuthenticated.value ? authState.value.token || '' : '';
    const currentHost = isAuthenticated.value ? authState.value.host || form.gitlabHost : form.gitlabHost;

    Object.assign(form, {
      appName: '',
      appNameZh: '',
      port: 8081,
      activeRule: '',
      apiBase: '/api',
      proxyTarget: import.meta.env.VITE_DEFAULT_PROXY_TARGET || 'http://localhost:3000',
      description: '',
      createRepo: true,
      gitlabHost: currentHost,
      gitlabToken: currentToken,
      namespaceId: '2088',
      visibility: 'private',
      framework: 'vue3',
    });
    result.value = null;
    progress.visible = false;
    progress.status = 'idle';
    progress.percent = 0;
    progress.currentStageKey = 'validate';
    progress.currentStageTitle = '准备创建';
    progress.currentMessage = '请选择配置后开始创建';
    progress.errorMessage = '';
    progress.elapsedMs = 0;
    progress.elapsedText = '00:00';
    progress.createRepo = true;
    progress.stages = buildProgressStages(true);
    progress.logs = [];
    progress.result = null;
    stopProgressTimer();
  };

  /**
   * 处理微应用创建
   * @description 创建微应用并推送到 GitLab，如果 Git push 失败则视为创建失败
   */
  const handleCreate = async () => {
    try {
      await formRef.value?.validate();
    } catch {
      // 校验未通过，错误已展示在各表单项下方
      return;
    }

    abortCreateRequest();
    const controller = new AbortController();
    createAbortController = controller;

    try {
      startProgress(Boolean(form.createRepo));
      appendLog('info', form.createRepo ? '将创建 GitLab 项目并推送代码' : '将仅生成项目下载包', 'validate');
      const responseData = await createMicroAppWithProgress(form, {
        signal: controller.signal,
        onEvent: handleProgressEvent,
      });

      if (controller.signal.aborted || createAbortController !== controller) return;

      if (responseData) {
        result.value = responseData;
        progress.result = responseData;
        progress.visible = true;
        progress.currentStageKey = 'finalize';
        progress.currentStageTitle = '完成收口';
        progress.currentMessage = '项目已创建完成';
        progress.percent = 100;
        progress.stages = progress.stages.map((item) => ({ ...item, status: 'finish' }));
        progress.status = 'success';
        appendLog('success', '创建流程完成', 'finalize');
        stopProgressTimer();
      }
      message.success('创建成功');
    } catch (e: any) {
      if (controller.signal.aborted) return;
      console.error('创建请求失败:', e);
      const errorMessage = e?.response?.data?.error || e?.message || '创建失败';
      failProgress(errorMessage);
      message.error({
        content: errorMessage,
      });
      result.value = null;
    } finally {
      if (createAbortController === controller) createAbortController = null;
      stopProgressTimer();
    }
  };

  return {
    form,
    progress,
    loading,
    result,
    handleCreate,
    handleReset,
    validateAppName,
    validateActiveRule,
    visibilityOptions,
    isAuthenticated,
    rules,
    formRef,
  };
}
