import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { getDeployRootOptions, type DeployRootOptionsResult } from '@/api/deploy';
import { getFileContentIfExists } from '@/api/gitlab';
import { detectDeployApplication, type DeployApplicationDetection } from './deployRootProjectDetector';
import {
  createDeployRootSelectOptions,
  createRecommendedDeployRoot,
  isCurrentDeployRootRefresh,
  normalizeDeployRoot,
  shouldWriteDeployRootRecommendation,
  type DeployRootSelectOption,
} from './deployRootRecommendationPolicy';

export type { DeployRootSelectOption } from './deployRootRecommendationPolicy';

/** 部署根目录推荐器输入。 */
export interface DeployRootRecommendationProps {
  modelValue?: string;
  projectType?: 'frontend' | 'backend';
  projectId?: number;
  projectName?: string;
  projectDescription?: string;
  defaultBranch?: string;
  serverId?: number;
  nginxInstanceId?: number;
  buildCommand?: string;
  artifactDir?: string;
  targetId?: number | null;
}

/** 部署根目录推荐器事件。 */
export interface DeployRootRecommendationEmit {
  (event: 'update:modelValue', value: string): void;
}

/** 从未知异常中提取适合表单展示的短消息。 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return '请求失败';
}

/**
 * 管理部署根目录的仓库识别、服务器候选与手动输入保护。
 * @param props 响应式组件属性
 * @param emit 双向绑定事件
 * @returns 部署根目录交互状态
 */
export function useDeployRootRecommendation(
  props: Readonly<DeployRootRecommendationProps>,
  emit: DeployRootRecommendationEmit
) {
  const loading = ref(false);
  const hint = ref('请选择项目、分支和服务器以智能识别部署目录');
  const options = ref<DeployRootSelectOption[]>([]);
  const recommendation = ref('');
  const autoManaged = ref(true);
  const canApplyRecommendation = computed(() => {
    const option = options.value.find((item) => item.value === recommendation.value);
    return Boolean(recommendation.value && !option?.disabled);
  });
  const displayedHint = computed(() => {
    const currentPath = normalizeDeployRoot(props.modelValue);
    const occupiedOption = options.value.find((item) => item.disabled && normalizeDeployRoot(item.value) === currentPath);
    return occupiedOption ? `${currentPath} ${occupiedOption.description}，请选择其他目录` : hint.value;
  });
  const detectionCache = new Map<string, Promise<DeployApplicationDetection>>();
  const serverCache = new Map<string, Promise<DeployRootOptionsResult>>();
  let refreshSequence = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let completedInitialRefresh = false;
  let focusBaseline = '';
  let filterActive = false;

  /** 获取带弹窗周期缓存的项目识别结果。 */
  const loadDetection = () => {
    const projectId = Number(props.projectId || 0);
    const defaultBranch = String(props.defaultBranch || '');
    const buildCommand = String(props.buildCommand || '');
    const artifactDir = props.artifactDir;
    const projectName = props.projectName;
    const projectDescription = props.projectDescription;
    const cacheKey = [
      projectId,
      defaultBranch,
      buildCommand,
      artifactDir,
      projectName,
      projectDescription,
    ].join('|');
    const cached = detectionCache.get(cacheKey);
    if (cached) return cached;
    const request = detectDeployApplication({
      buildCommand,
      artifactDir,
      projectName,
      projectDescription,
      readFile: async (filePath) => {
        const result = await getFileContentIfExists(projectId, filePath, defaultBranch);
        return result?.content ?? null;
      },
    }).catch((error) => {
      detectionCache.delete(cacheKey);
      throw error;
    });
    detectionCache.set(cacheKey, request);
    return request;
  };

  /** 获取带弹窗周期缓存的服务器目录结果。 */
  const loadServerOptions = () => {
    const serverId = Number(props.serverId || 0);
    const nginxInstanceId = Number(props.nginxInstanceId || 0) || undefined;
    const excludeTargetId = Number(props.targetId || 0) || undefined;
    const cacheKey = [serverId, nginxInstanceId || 0, excludeTargetId || 0].join('|');
    const cached = serverCache.get(cacheKey);
    if (cached) return cached;
    const request = getDeployRootOptions(serverId, {
      nginxInstanceId,
      excludeTargetId,
    }).catch((error) => {
      serverCache.delete(cacheKey);
      throw error;
    });
    serverCache.set(cacheKey, request);
    return request;
  };

  /** 将可用且未占用的推荐值写回 Formily。 */
  const applyRecommendation = () => {
    const value = recommendation.value;
    const option = options.value.find((item) => item.value === value);
    if (!value || option?.disabled) return;
    autoManaged.value = true;
    emit('update:modelValue', value);
  };

  /** 刷新仓库识别与服务器应用目录。 */
  const refresh = async () => {
    const sequence = ++refreshSequence;
    if (props.projectType !== 'frontend') {
      loading.value = false;
      options.value = [];
      recommendation.value = '';
      hint.value = '';
      return;
    }
    if (!props.projectId || !props.defaultBranch || !props.serverId) {
      loading.value = false;
      options.value = [];
      recommendation.value = '';
      hint.value = '请选择项目、分支和服务器以智能识别部署目录';
      return;
    }

    loading.value = true;
    hint.value = '正在读取分支配置和服务器应用目录...';
    const [detectionResult, serverResult] = await Promise.allSettled([loadDetection(), loadServerOptions()]);
    if (!isCurrentDeployRootRefresh(sequence, refreshSequence)) return;
    loading.value = false;
    const detection = detectionResult.status === 'fulfilled' ? detectionResult.value : null;
    const server = serverResult.status === 'fulfilled' ? serverResult.value : null;
    const nextRecommendation = createRecommendedDeployRoot(server?.configuredRoot || '', detection);
    recommendation.value = nextRecommendation;
    options.value = createDeployRootSelectOptions(server, nextRecommendation, detection);
    const recommendedOption = options.value.find((item) => item.value === nextRecommendation);

    if (detectionResult.status === 'rejected' && serverResult.status === 'rejected') {
      hint.value = `项目配置读取失败：${getErrorMessage(detectionResult.reason)}；服务器目录读取失败：${getErrorMessage(serverResult.reason)}，可直接输入绝对路径`;
    } else if (detectionResult.status === 'rejected') {
      hint.value = `项目分支配置读取失败：${getErrorMessage(detectionResult.reason)}，可从服务器应用中选择或直接输入`;
    } else if (serverResult.status === 'rejected') {
      hint.value = `服务器目录读取失败：${getErrorMessage(serverResult.reason)}，可直接输入绝对路径`;
    } else if (server?.scanWarning) {
      hint.value = `服务器目录暂不可读取：${server.scanWarning}；已保留配置根目录，可继续手动输入和保存`;
    } else if (detection?.status === 'unresolved') {
      hint.value = `${detection.reason}，请从服务器应用中选择或直接输入`;
    } else if (recommendedOption?.disabled) {
      hint.value = `${nextRecommendation} 已被其他部署目标占用，请选择其他目录`;
    } else if (nextRecommendation) {
      hint.value = `${detection?.reason || '已识别项目目录'}${server?.truncated ? '；服务器目录较多，仅显示前 200 项' : ''}`;
    } else {
      hint.value = '未生成安全的推荐目录，请直接输入绝对路径';
    }

    const preserveInitialEditValue = Boolean(props.targetId && !completedInitialRefresh);
    completedInitialRefresh = true;
    if (shouldWriteDeployRootRecommendation({
      responseSequence: sequence,
      activeSequence: refreshSequence,
      autoManaged: autoManaged.value,
      preserveInitialEditValue,
      recommendation: nextRecommendation,
      recommendationDisabled: Boolean(recommendedOption?.disabled),
    })) {
      emit('update:modelValue', nextRecommendation);
    }
  };

  /** 延迟刷新，避免编辑构建命令时逐键发起请求。 */
  const scheduleRefresh = () => {
    /** 依赖一变化就让在途响应失效，不能等待防抖结束后再递增代次。 */
    refreshSequence += 1;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, 250);
  };

  /** 处理字段输入；只有可用推荐值继续保持自动管理。 */
  const handleValueChange = (value: string) => {
    const nextValue = String(value || '');
    filterActive = nextValue !== focusBaseline;
    const recommendedOption = options.value.find((item) => item.recommended && item.value === nextValue);
    autoManaged.value = Boolean(recommendedOption && !recommendedOption.disabled);
    emit('update:modelValue', nextValue);
  };

  /** 处理下拉选择；选择智能推荐时继续保持自动管理。 */
  const handleSelect = (value: string, option: DeployRootSelectOption) => {
    if (option?.disabled) return;
    focusBaseline = value;
    filterActive = false;
    autoManaged.value = Boolean(option?.recommended);
    emit('update:modelValue', value);
  };

  /** 按路径和说明搜索候选。 */
  const filterOption = (input: string, option?: DeployRootSelectOption) => {
    if (!filterActive) return true;
    const keyword = String(input || '').trim().toLowerCase();
    if (!keyword) return true;
    return `${option?.value || ''} ${option?.description || ''}`.toLowerCase().includes(keyword);
  };

  /** 记录本次聚焦基线，初次展开时展示全部服务器候选。 */
  const handleFocus = () => {
    focusBaseline = String(props.modelValue || '');
    filterActive = false;
  };

  watch(
    () => [
      props.projectType,
      props.projectId,
      props.defaultBranch,
      props.serverId,
      props.nginxInstanceId,
      props.buildCommand,
      props.artifactDir,
      props.projectName,
      props.projectDescription,
      props.targetId,
    ],
    scheduleRefresh,
    { immediate: true }
  );

  onBeforeUnmount(() => {
    refreshSequence += 1;
    if (refreshTimer) clearTimeout(refreshTimer);
  });

  return {
    loading,
    hint: displayedHint,
    options,
    recommendation,
    autoManaged,
    canApplyRecommendation,
    applyRecommendation,
    filterOption,
    handleFocus,
    handleSelect,
    handleValueChange,
  };
}
