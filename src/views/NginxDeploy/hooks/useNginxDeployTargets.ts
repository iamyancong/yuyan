import { computed, nextTick, reactive, ref, watch, type Ref } from 'vue';
import message from 'ant-design-vue/es/message';
import {
  createDeployTarget,
  deleteDeployTarget,
  getNextNginxInstancePort,
  listDeployTargets,
  syncNginxSite,
  updateDeployTarget,
  type DeployServer,
  type DeployTarget,
  type DeployTargetPayload,
  type DeployTargetQuery,
  type DeployProjectSource,
  type NginxInstance,
} from '@/api/deploy';
import {
  DEFAULT_ARTIFACT_DIR,
  DEFAULT_BUILD_COMMAND,
  DEFAULT_INSTALL_COMMAND,
  DEFAULT_PRESERVE_SUB_DIRS,
  DEFAULT_PROJECT_SOURCE,
  DEFAULT_UPLOAD_STRATEGY,
  TEST_ENV_NAME,
  applyProjectTemplate,
  targetFormSchema,
} from '../constant';
import {
  PROJECT_SELECT_DROPDOWN_CLASS,
  normalizeProjectSource,
  useDeployProjectOptions,
  renderTwoLineSelectOption,
} from './useDeployProjectOptions';
import type { DeployProjectContext, DeployTargetProjectDraft, FormilyRef, RefreshActiveTabOptions, RuntimeAwareDeployTarget, TargetFilterForm } from '../types';
import {
  createBranchOptions,
  createProjectDraftFromContext,
  createProjectDraftFromGitLab,
  createServerOptionsFromTargets,
  createTargetServerDefaults,
  findMainManagedSiteTarget,
  formatServerLabel,
  getErrorMessage,
  getPreferredNginxInstance,
  getVisibleNginxInstances,
  isMainDeployProject,
  syncSelectFieldState,
} from '../utils';
import { useNginxDeployContext } from './useNginxDeployContext';
import { useTargetRuntime } from './useTargetRuntime';
import { useTargetNginxConf } from './useTargetNginxConf';

/** 部署目标 Hook 参数 */
interface UseNginxDeployTargetsParams {
  project: DeployProjectContext;
  ensureLoggedIn: () => boolean;
  refreshActiveTab: (options?: RefreshActiveTabOptions) => Promise<void>;
  servers: Ref<DeployServer[]>;
  refreshServerList: () => Promise<void>;
}

/**
 * 构建部署目标表单默认值。
 * @param project 当前路由项目上下文
 * @returns 部署目标表单初始值
 */
const createDefaultTargetForm = (project: DeployProjectContext): DeployTargetPayload => ({
  projectSource: DEFAULT_PROJECT_SOURCE,
  projectId: project.projectId,
  projectName: project.projectName,
  projectDescription: project.projectDescription,
  projectPath: project.projectPath,
  repositoryUrl: project.repositoryUrl,
  defaultBranch: project.defaultBranch,
  envName: TEST_ENV_NAME,
  serverId: 0,
  nginxInstanceId: 0,
  deployRoot: '',
  nginxConfPath: '',
  nginxSiteManaged: false,
  listenPort: 0,
  serverName: '_',
  enableNginxTest: false,
  enableNginxReload: false,
  installCommand: DEFAULT_INSTALL_COMMAND,
  buildCommand: DEFAULT_BUILD_COMMAND,
  artifactDir: DEFAULT_ARTIFACT_DIR,
  preserveSubDirs: DEFAULT_PRESERVE_SUB_DIRS,
  uploadStrategy: DEFAULT_UPLOAD_STRATEGY,
  visitUrl: '',
  remark: '',
});

/**
 * 管理部署目标列表、筛选和配置表单。
 * @description 通过 Provide/Inject 上下文与微 Hooks 裂变进行了深度重构。原巨无霸 Hook 大幅减负。
 * @param params 可选的认证、刷新和服务器依赖（不传时默认使用 NginxDeployContext）
 * @returns 部署目标数据、表单状态和操作方法
 */
export function useNginxDeployTargets(params?: UseNginxDeployTargetsParams) {
  // 优先使用传入的 params，无传入时使用 context 注入，平滑保障向后兼容性
  const fallbackContext = useNginxDeployContext;
  const getContext = () => {
    try {
      return fallbackContext();
    } catch {
      return null;
    }
  };
  const context = getContext();

  const activeProject = params?.project ?? context?.project!;
  const ensureLoggedIn = params?.ensureLoggedIn ?? context?.ensureLoggedIn!;
  const refreshActiveTab = params?.refreshActiveTab ?? context?.refreshActiveTab!;
  const servers = params?.servers ?? context?.servers!;
  const refreshServerList = params?.refreshServerList ?? context?.refreshServerList!;

  const {
    projectLoading,
    branchLoading,
    branchProjectId,
    projectSource: activeProjectSource,
    projects: deployProjects,
    branches: deployBranches,
    projectOptions,
    branchOptions,
    loadProjects,
    findProject,
    loadBranches,
    resolveDefaultBranch,
  } = useDeployProjectOptions();

  const targetSaving = ref(false);
  const targetBindingRepairing = ref(false);
  const targetFormLoading = ref(false);
  const targets = ref<DeployTarget[]>([]);
  const allTargets = ref<DeployTarget[]>([]);

  const targetFilterForm = reactive<TargetFilterForm>({
    projectKeyword: activeProject?.projectName || '',
    branch: undefined,
    serverId: undefined,
  });

  const targetModalOpen = ref(false);
  const activeTargetId = ref<number | null>(null);
  const targetFormRef = ref<FormilyRef | null>(null);
  const initializingTargetForm = ref(false);
  const syncingProjectId = ref<number | null>(null);
  /** 防止 handleTargetProjectSourceChange 被 watcher 和 onChange 重复触发 */
  let changingProjectSource = false;
  const targetForm = reactive<DeployTargetPayload>(createDefaultTargetForm(activeProject));

  // ==========================================
  // 核心战役 2.1: 引入裂变出来的子 Hooks
  // ==========================================
  
  // 运行态长轮询与快照子 Hook
  const {
    targetRuntimeSnapshots,
    targetRuntimeLoading,
    getTargetRuntimeSnapshot,
    setTargetRuntimeSnapshot,
    clearTargetRuntimeSnapshot,
    ensureTargetIdle,
    refreshTargetRuntimeSnapshots,
    startTargetRuntimePolling,
    stopTargetRuntimePolling,
    cancelPendingRequests,
  } = useTargetRuntime(targets);

  // Nginx 配置文件读写与校验子 Hook
  const {
    nginxTargetId,
    openNginxConfig,
    handleSaveNginxConf,
    handleTestNginxConf,
  } = useTargetNginxConf(ensureTargetIdle, ensureLoggedIn);

  // ==========================================

  /** 部署目标表单双向绑定模型 */
  const targetFormModel = computed<DeployTargetPayload>({
    get: () => ({ ...targetForm }),
    set: (values) => {
      Object.assign(targetForm, values || {});
    },
  });

  /** 带运行态快照的部署目标表格数据 */
  const runtimeTargets = computed<RuntimeAwareDeployTarget[]>(() =>
    targets.value.map((target) => ({
      ...target,
      runtimeSnapshot: targetRuntimeSnapshots.value[target.id],
    }))
  );

  /** 部署目标表单稳定 Schema，避免下拉状态变化时重建表单 */
  const targetSchema = JSON.parse(JSON.stringify(targetFormSchema));

  const targetServerFilterOptions = computed(() => {
    if (servers?.value?.length) {
      return servers.value.map((server) => ({
        label: renderTwoLineSelectOption({ title: server.name, description: server.host }),
        title: server.name,
        searchKey: `${server.name} ${server.host}`,
        value: server.id,
      }));
    }
    return createServerOptionsFromTargets(allTargets.value.length ? allTargets.value : targets.value);
  });

  const targetBranchFilterOptions = computed(() => {
    const serverId = Number(targetFilterForm.serverId || 0);
    const filteredTargets = serverId
      ? allTargets.value.filter((t) => Number(t.serverId || 0) === serverId)
      : allTargets.value;
    return createBranchOptions(filteredTargets).map((opt) => {
      const name = String(opt.value);
      return {
        label: renderTwoLineSelectOption({ title: name, description: '代码分支' }),
        title: name,
        searchKey: `${name} 代码分支`,
        value: name,
      };
    });
  });

  const targetNginxInstanceOptions = computed(() => {
    const server = servers.value.find((item) => item.id === Number(targetForm.serverId));
    return getVisibleNginxInstances(server).map((instance) => {
      const typeLabel = instance.instanceType === 'managed' ? '系统托管' : '外部已有';
      const desc = `${typeLabel} · 绑定 ${instance.targetCount || 0} 个项目`;
      return {
        label: renderTwoLineSelectOption({ title: instance.name, description: desc }),
        title: instance.name,
        searchKey: `${instance.name} ${desc}`,
        value: instance.id,
      };
    });
  });

  /** 当前项目是否有效 */
  const hasProjectContext = computed(() => Boolean(activeProject?.projectId && activeProject?.projectName && activeProject?.repositoryUrl));

  /** 获取当前项目来源 */
  const getCurrentProjectSource = (): DeployProjectSource => normalizeProjectSource(targetForm.projectSource);

  /** 同步部署目标弹窗项目来源状态 */
  const syncTargetProjectSourceFieldState = () => {
    targetFormRef.value?.setFieldState?.('projectSource', (state: any) => {
      state.componentProps = {
        ...(state.componentProps || {}),
        onChange: handleTargetProjectSourceChange,
      };
    });
  };

  /** 同步部署目标弹窗项目下拉状态 */
  const syncTargetProjectFieldState = () => {
    const source = getCurrentProjectSource();
    syncSelectFieldState(targetFormRef.value, 'projectId', projectOptions.value, {
      loading: projectLoading.value,
      showSearch: true,
      optionFilterProp: 'searchKey',
      optionLabelProp: 'title',
      placeholder: source === 'gitlab' ? '请选择 GitLab 仓库' : '请选择平台应用',
      class: 'project-select',
      popupClassName: PROJECT_SELECT_DROPDOWN_CLASS,
      onChange: handleTargetProjectChange,
    });
  };

  /** 同步部署目标弹窗分支下拉状态 */
  const syncTargetBranchFieldState = () => {
    syncSelectFieldState(targetFormRef.value, 'defaultBranch', branchOptions.value, {
      loading: branchLoading.value,
      disabled: !targetForm.projectId,
      showSearch: true,
      optionFilterProp: 'searchKey',
      optionLabelProp: 'title',
      class: 'project-select',
      popupClassName: PROJECT_SELECT_DROPDOWN_CLASS,
      placeholder: targetForm.projectId ? '请选择分支' : '请先选择项目',
    });
  };

  /** 同步部署目标弹窗服务器下拉状态 */
  const syncTargetServerFieldState = () => {
    syncSelectFieldState(targetFormRef.value, 'serverId', targetServerFilterOptions.value, {
      showSearch: true,
      optionFilterProp: 'searchKey',
      optionLabelProp: 'title',
      class: 'project-select',
      popupClassName: PROJECT_SELECT_DROPDOWN_CLASS,
      placeholder: '请选择部署服务器',
    });
  };

  /** 同步部署目标弹窗 Nginx 实例下拉状态 */
  const syncTargetNginxInstanceFieldState = () => {
    const hasOptions = targetNginxInstanceOptions.value.length > 0;
    syncSelectFieldState(targetFormRef.value, 'nginxInstanceId', targetNginxInstanceOptions.value, {
      disabled: !targetForm.serverId || !hasOptions,
      showSearch: true,
      optionFilterProp: 'searchKey',
      optionLabelProp: 'title',
      class: 'project-select',
      popupClassName: PROJECT_SELECT_DROPDOWN_CLASS,
      placeholder: !targetForm.serverId ? '请先选择部署服务器' : hasOptions ? '请选择 Nginx 实例' : '请先在 Nginx 管理新增托管实例',
    });
  };

  /** 同步托管站点相关的字段显隐状态 */
  const syncTargetNginxSiteManagedState = () => {
    const isManaged = Boolean(targetForm.nginxSiteManaged);
    targetFormRef.value?.setFieldState?.('visitUrl', (state: any) => {
      state.display = isManaged ? 'visible' : 'none';
    });
    targetFormRef.value?.setFieldState?.('listenPort', (state: any) => {
      state.display = isManaged ? 'visible' : 'none';
    });
    targetFormRef.value?.setFieldState?.('serverName', (state: any) => {
      state.display = isManaged ? 'visible' : 'none';
    });
  };

  /** 同步部署目标表单值到 Formily 内部状态 */
  const syncTargetFormValues = () => {
    targetFormRef.value?.setValues?.({ ...targetForm });
  };

  /**
   * 读取部署目标表单当前值。
   * @returns 最新表单快照
   */
  const getTargetFormSnapshot = () => {
    const values = (targetFormRef.value?.getValues?.() || {}) as Partial<DeployTargetPayload>;
    return { ...targetForm, ...values };
  };

  /**
   * 获取部署目标列表查询参数。
   * @returns 部署目标查询参数
   */
  const getTargetQueryParams = (): DeployTargetQuery => {
    const queryParams: DeployTargetQuery = {};
    const projectKeyword = String(targetFilterForm.projectKeyword || '').trim();
    if (projectKeyword) queryParams.projectKeyword = projectKeyword;
    if (targetFilterForm.branch) queryParams.branch = targetFilterForm.branch;
    if (targetFilterForm.serverId) queryParams.serverId = Number(targetFilterForm.serverId);
    return queryParams;
  };

  /**
   * 获取部署目标服务器筛选默认值。
   * @returns 首个服务器筛选值
   */
  const getDefaultTargetServerFilter = (): number | undefined => {
    const firstValue = targetServerFilterOptions.value[0]?.value;
    const normalizedValue = Number(firstValue || 0);
    return normalizedValue || undefined;
  };

  /**
   * 确保部署目标服务器筛选默认选中首个选项。
   * @returns 是否更新了服务器筛选值
   */
  const ensureTargetServerFilter = (): boolean => {
    const options = targetServerFilterOptions.value;
    if (!options.length) {
      if (!targetFilterForm.serverId) return false;
      targetFilterForm.serverId = undefined;
      return true;
    }
    const currentServerId = Number(targetFilterForm.serverId || 0);
    const hasCurrentServer = options.some((option) => Number(option.value) === currentServerId);
    if (currentServerId && hasCurrentServer) return false;
    targetFilterForm.serverId = getDefaultTargetServerFilter();
    return true;
  };

  /**
   * 获取新增部署目标时默认选中的项目。
   * @returns 项目快照
   */
  const getDefaultTargetProject = (): DeployTargetProjectDraft | null => {
    const source = getCurrentProjectSource();
    if (source === 'ops' && hasProjectContext.value) {
      const matchedProject = findProject(source, activeProject.projectId);
      return matchedProject ? createProjectDraftFromGitLab(matchedProject, source) : createProjectDraftFromContext(activeProject);
    }
    const firstProject = deployProjects.value[0];
    return firstProject ? createProjectDraftFromGitLab(firstProject, source) : null;
  };

  /**
   * 获取服务器默认 Nginx 实例。
   * @param server 部署服务器
   * @returns Nginx 实例
   */
  const getDefaultNginxInstance = (server?: DeployServer): NginxInstance | undefined => {
    return getPreferredNginxInstance(server);
  };

  /**
   * 获取当前表单选中的 Nginx 实例。
   * @param server 部署服务器
   * @returns Nginx 实例
   */
  const getSelectedNginxInstance = (server?: DeployServer): NginxInstance | undefined => {
    if (!server) return undefined;
    return server.nginxInstances?.find((instance) => instance.id === Number(targetForm.nginxInstanceId)) || getDefaultNginxInstance(server);
  };

  /**
   * 根据服务器和项目名刷新部署路径默认值。
   * @param server 部署服务器
   * @param appName 项目名
   */
  const applyTargetServerDefaults = (server: DeployServer | undefined, appName: string, nginxInstance = getSelectedNginxInstance(server)) => {
    if (!server || !appName) return;
    // 新增部署目标弹窗默认不自动开启「校验/重载 Nginx」。
    // 仅当用户在弹窗内手动切换后，才保留其选择结果。
    const shouldKeepNginxFlags = activeTargetId.value === null;
    const prevEnableNginxTest = targetForm.enableNginxTest;
    const prevEnableNginxReload = targetForm.enableNginxReload;
    Object.assign(
      targetForm,
      createTargetServerDefaults(
        server,
        appName,
        applyProjectTemplate,
        nginxInstance,
        {
          projectName: targetForm.projectName,
          projectDescription: targetForm.projectDescription || '',
        },
        allTargets.value.length ? allTargets.value : targets.value
      )
    );
    if (shouldKeepNginxFlags) {
      targetForm.enableNginxTest = prevEnableNginxTest;
      targetForm.enableNginxReload = prevEnableNginxReload;
    }
    if (nginxInstance?.instanceType !== 'managed') {
      targetForm.listenPort = 0;
      targetForm.visitUrl = '';
    }
  };

  /**
   * 根据托管 Nginx 服务器补齐站点端口和访问地址。
   * @param server 部署服务器
   */
  const applyManagedNginxDefaults = async (server: DeployServer | undefined, nginxInstance = getSelectedNginxInstance(server)) => {
    if (!server || !nginxInstance || nginxInstance.instanceType !== 'managed' || !nginxInstance.initializedAt || nginxInstance.status === 'uninitialized') return;
    if (!isMainDeployProject(targetForm)) {
      targetForm.nginxSiteManaged = false;
      targetForm.listenPort = 0;
      targetForm.visitUrl = '';
      syncTargetFormValues();
      return;
    }
    if (!targetForm.listenPort) {
      const result = await getNextNginxInstancePort(nginxInstance.id);
      targetForm.listenPort = result.port;
    }
    targetForm.nginxSiteManaged = true;
    targetForm.serverName = targetForm.serverName || '_';
    targetForm.visitUrl = `http://${server.host}:${targetForm.listenPort}`;
    syncTargetFormValues();
  };

  /**
   * 将项目快照写入部署目标表单。
   * @param draft 项目快照
   */
  const applyTargetProjectDraft = (draft: DeployTargetProjectDraft) => {
    Object.assign(targetForm, {
      projectSource: draft.projectSource,
      projectId: draft.projectId,
      projectName: draft.projectName,
      projectDescription: draft.projectDescription,
      projectPath: draft.projectPath,
      repositoryUrl: draft.repositoryUrl,
      defaultBranch: draft.defaultBranch || 'dev',
    });
  };

  /** 重置部署目标表单 */
  const resetTargetForm = () => {
    const selectedServer = servers.value[0];
    activeProjectSource.value = DEFAULT_PROJECT_SOURCE;
    targetForm.projectSource = DEFAULT_PROJECT_SOURCE;
    const selectedProject = getDefaultTargetProject();
    initializingTargetForm.value = true;
    activeTargetId.value = null;
    Object.assign(targetForm, {
      projectSource: DEFAULT_PROJECT_SOURCE,
      projectId: selectedProject?.projectId || 0,
      projectName: selectedProject?.projectName || '',
      projectDescription: selectedProject?.projectDescription || '',
      projectPath: selectedProject?.projectPath || '',
      repositoryUrl: selectedProject?.repositoryUrl || '',
      defaultBranch: selectedProject?.defaultBranch || 'dev',
      envName: TEST_ENV_NAME,
      serverId: selectedServer?.id || 0,
      nginxInstanceId: getDefaultNginxInstance(selectedServer)?.id || 0,
      deployRoot: '',
      nginxConfPath: '',
      nginxSiteManaged: false,
      listenPort: 0,
      serverName: '_',
      enableNginxTest: false,
      enableNginxReload: false,
      installCommand: DEFAULT_INSTALL_COMMAND,
      buildCommand: DEFAULT_BUILD_COMMAND,
      artifactDir: DEFAULT_ARTIFACT_DIR,
      preserveSubDirs: DEFAULT_PRESERVE_SUB_DIRS,
      uploadStrategy: DEFAULT_UPLOAD_STRATEGY,
      visitUrl: '',
    });
    applyTargetServerDefaults(selectedServer, selectedProject?.projectName || '');
    void applyManagedNginxDefaults(selectedServer);
    initializingTargetForm.value = false;
    syncTargetFormValues();
  };

  /**
   * 根据表单项目 ID 同步项目详情和分支选项。
   * @param projectId 项目 ID
   * @param options 同步选项
   */
  const syncTargetProject = async (projectId: number, options: { resetPaths?: boolean } = {}) => {
    const normalizedProjectId = Number(projectId || 0);
    const source = getCurrentProjectSource();
    const currentValues = getTargetFormSnapshot();
    const selectedProject = findProject(source, normalizedProjectId);
    if (!selectedProject) {
      if (syncingProjectId.value === normalizedProjectId) {
        syncingProjectId.value = null;
      }
      return;
    }
    syncingProjectId.value = normalizedProjectId;
    try {
      const draft = createProjectDraftFromGitLab(selectedProject, source);
      applyTargetProjectDraft({ ...draft, defaultBranch: '' });
      targetForm.serverId = Number(currentValues.serverId || targetForm.serverId || 0);
      targetForm.nginxInstanceId = Number(currentValues.nginxInstanceId || targetForm.nginxInstanceId || 0);
      targetForm.envName = TEST_ENV_NAME;
      syncTargetFormValues();
      const branchRequest = loadBranches(normalizedProjectId);
      await nextTick();
      syncTargetBranchFieldState();
      await branchRequest;
      if (branchProjectId.value !== normalizedProjectId || Number(targetForm.projectId) !== normalizedProjectId) return;
      const nextBranch = resolveDefaultBranch(draft.defaultBranch);
      applyTargetProjectDraft({ ...draft, defaultBranch: nextBranch });
      if (options.resetPaths !== false) {
        const selectedServer = servers.value.find((server) => server.id === Number(targetForm.serverId));
        const selectedInstance = getSelectedNginxInstance(selectedServer);
        applyTargetServerDefaults(selectedServer, draft.projectName, selectedInstance);
        await applyManagedNginxDefaults(selectedServer, selectedInstance);
      }
      await nextTick();
      syncTargetBranchFieldState();
      syncTargetNginxInstanceFieldState();
      syncTargetFormValues();
    } catch (error: any) {
      targetForm.defaultBranch = '';
      await nextTick();
      syncTargetBranchFieldState();
      syncTargetFormValues();
      message.error(getErrorMessage(error));
    } finally {
      if (syncingProjectId.value === normalizedProjectId) {
        syncingProjectId.value = null;
      }
    }
  };

  /**
   * 处理部署目标项目来源变化。
   * @param value 选中的项目来源
   */
  async function handleTargetProjectSourceChange(value?: string) {
    const nextSource = normalizeProjectSource(value);
    if (initializingTargetForm.value || !targetModalOpen.value) return;
    // 防重入：避免 onChange 回调和 watch(projectSource) 同时触发
    if (changingProjectSource) return;
    changingProjectSource = true;
    activeProjectSource.value = nextSource;
    targetForm.projectSource = nextSource;
    syncingProjectId.value = null;
    Object.assign(targetForm, {
      projectId: undefined,
      projectName: '',
      projectDescription: '',
      projectPath: '',
      repositoryUrl: '',
      defaultBranch: '',
    });
    await loadBranches(0);
    syncTargetFormValues();
    syncTargetProjectFieldState();
    syncTargetBranchFieldState();
    try {
      const projectList = await loadProjects(nextSource);
      await nextTick();
      syncTargetProjectFieldState();
      const firstProject = projectList[0];
      if (firstProject) {
        // 提前设置 syncingProjectId，阻止 watch(projectId) 重复触发 syncTargetProject
        syncingProjectId.value = firstProject.id;
        await syncTargetProject(firstProject.id);
      } else {
        syncTargetFormValues();
        syncTargetBranchFieldState();
      }
    } catch (error: any) {
      message.error(getErrorMessage(error));
    } finally {
      changingProjectSource = false;
    }
  }

  /**
   * 处理部署目标项目选择变化。
   * @param value 选中的 GitLab 项目 ID
   */
  function handleTargetProjectChange(value?: string | number) {
    const nextProjectId = Number(value || 0);
    if (initializingTargetForm.value || !targetModalOpen.value || !nextProjectId) return;
    syncingProjectId.value = nextProjectId;
    if (Number(targetForm.projectId) !== nextProjectId) {
      targetForm.projectId = nextProjectId;
    }
    void syncTargetProject(nextProjectId);
  }

  /** 刷新部署目标列表 */
  const refreshTargetList = async () => {
    let queryParams = getTargetQueryParams();
    let targetList = await listDeployTargets(queryParams);
    targets.value = targetList;
    if (!Object.keys(queryParams).length || !allTargets.value.length) {
      allTargets.value = targetList;
    }
    const shouldReloadByDefaultServer = ensureTargetServerFilter() && !queryParams.serverId;
    if (shouldReloadByDefaultServer) {
      queryParams = getTargetQueryParams();
      targetList = await listDeployTargets(queryParams);
      targets.value = targetList;
    }
    await refreshTargetRuntimeSnapshots(targetList);
    startTargetRuntimePolling();
  };

  /** 打开新增部署目标弹窗 */
  const openCreateTarget = async () => {
    if (!ensureLoggedIn()) return;
    // 立即打开弹窗，展现 Loading 状态以提高响应体验
    targetModalOpen.value = true;
    targetFormLoading.value = true;
    try {
      // 预先重置表单为默认值以作骨架数据占位
      resetTargetForm();
      // 开始加载依赖接口
      await refreshServerList();
      if (!servers.value.length) {
        message.warning('请先新增独立服务器');
        targetModalOpen.value = false;
        return;
      }
      await loadProjects(DEFAULT_PROJECT_SOURCE);
      if (!deployProjects.value.length && !hasProjectContext.value) {
        message.warning('暂无可选择的平台应用，请先在平台应用列表确认应用');
        targetModalOpen.value = false;
        return;
      }
      // 数据准备就绪后，再次重置并填充完整的默认表单数据
      resetTargetForm();
      if (targetForm.projectId) {
        await loadBranches(Number(targetForm.projectId));
        if (!deployBranches.value.some((branch) => branch.name === targetForm.defaultBranch)) {
          targetForm.defaultBranch = resolveDefaultBranch(targetForm.defaultBranch || 'dev');
        }
      }
      await nextTick();
      syncTargetProjectSourceFieldState();
      syncTargetProjectFieldState();
      syncTargetBranchFieldState();
      syncTargetNginxInstanceFieldState();
      syncTargetServerFieldState();
      syncTargetNginxSiteManagedState();
      syncTargetFormValues();
    } catch (error: any) {
      message.error(getErrorMessage(error));
      targetModalOpen.value = false; // 加载异常时自动关闭弹窗
    } finally {
      targetFormLoading.value = false;
    }
  };

  /**
   * 打开编辑部署目标弹窗。
   * @param target 部署目标
   */
  const openEditTarget = async (target: DeployTarget) => {
    if (!ensureLoggedIn()) return;
    if (targetFormLoading.value) return;
    if (!(await ensureTargetIdle(target, '编辑'))) return;
    targetFormLoading.value = true;
    activeTargetId.value = target.id;
    initializingTargetForm.value = true;
    Object.assign(targetForm, { ...target, projectSource: normalizeProjectSource(target.projectSource), serverName: target.nginxServerName || '_' });
    activeProjectSource.value = normalizeProjectSource(target.projectSource);
    initializingTargetForm.value = false;
    targetModalOpen.value = true;
    try {
      await refreshServerList();
      await loadProjects(normalizeProjectSource(target.projectSource));
      initializingTargetForm.value = true;
      Object.assign(targetForm, { ...target, projectSource: normalizeProjectSource(target.projectSource), serverName: target.nginxServerName || '_' });
      if (!targetForm.nginxInstanceId) {
        const selectedServer = servers.value.find((server) => server.id === Number(targetForm.serverId));
        targetForm.nginxInstanceId = getDefaultNginxInstance(selectedServer)?.id || 0;
      }
      initializingTargetForm.value = false;
      await loadBranches(Number(target.projectId));
      await nextTick();
      syncTargetProjectSourceFieldState();
      syncTargetProjectFieldState();
      syncTargetBranchFieldState();
      syncTargetServerFieldState();
      syncTargetNginxInstanceFieldState();
      syncTargetNginxSiteManagedState();
      syncTargetFormValues();
    } catch (error: any) {
      initializingTargetForm.value = false;
      message.error(getErrorMessage(error));
      targetModalOpen.value = false; // 加载异常时自动关闭弹窗
    } finally {
      targetFormLoading.value = false;
    }
  };

  /** 保存部署目标 */
  const saveTarget = async () => {
    if (!ensureLoggedIn()) return;
    if (targetFormLoading.value) return;
    targetSaving.value = true;
    try {
      const values = (targetFormRef.value?.getValues?.() || targetForm) as DeployTargetPayload;
      const installCommand = normalizeCommandText(values.installCommand ?? targetForm.installCommand);
      const buildCommand = normalizeCommandText(values.buildCommand ?? targetForm.buildCommand);
      const payload = {
        ...targetForm,
        ...values,
        projectSource: normalizeProjectSource(values.projectSource || targetForm.projectSource),
        envName: TEST_ENV_NAME,
        enableNginxTest: Boolean(values.enableNginxTest ?? targetForm.enableNginxTest),
        enableNginxReload: Boolean(values.enableNginxReload ?? targetForm.enableNginxReload),
        uploadStrategy: values.uploadStrategy || targetForm.uploadStrategy || DEFAULT_UPLOAD_STRATEGY,
        installCommand,
        buildCommand,
      };
      if (!payload.projectId || !payload.projectName || !payload.repositoryUrl) {
        message.warning(payload.projectSource === 'gitlab' ? '请选择 GitLab 仓库' : '请选择平台应用');
        return;
      }
      if (!String(payload.defaultBranch || '').trim()) {
        message.warning('请选择部署分支');
        return;
      }
      if (!payload.installCommand) {
        message.warning('请填写安装命令');
        return;
      }
      if (!payload.buildCommand) {
        message.warning('请填写构建命令');
        return;
      }
      const selectedServer = servers.value.find((server) => server.id === Number(payload.serverId));
      if (!selectedServer) {
        message.warning('部署服务器不存在，请先新增或重新选择独立服务器');
        return;
      }
      const selectedInstance = selectedServer.nginxInstances?.find((instance) => instance.id === Number(payload.nginxInstanceId));
      if (!selectedInstance) {
        message.warning('请选择 Nginx 实例');
        return;
      }
      if (
        !String(payload.deployRoot || '')
          .trim()
          .startsWith('/')
      ) {
        message.warning('部署根目录必须使用服务器绝对路径');
        return;
      }
      if (
        !String(payload.nginxConfPath || '')
          .trim()
          .startsWith('/')
      ) {
        message.warning('Nginx 配置文件路径必须使用服务器绝对路径');
        return;
      }
      if (payload.nginxSiteManaged && (!Number.isInteger(Number(payload.listenPort)) || Number(payload.listenPort) < 1 || Number(payload.listenPort) > 65535)) {
        message.warning('托管站点监听端口必须在 1-65535 之间');
        return;
      }
      if (activeTargetId.value) {
        const currentTarget = targets.value.find((target) => target.id === activeTargetId.value);
        if (!(await ensureTargetIdle(currentTarget || { id: activeTargetId.value, projectName: payload.projectName }, '保存配置'))) return;
      }
      if (activeTargetId.value) {
        const savedTarget = await updateDeployTarget(activeTargetId.value, payload);
        if (savedTarget.nginxSiteManaged) {
          await syncNginxSite(savedTarget.id);
        }
        message.success('部署目标已更新');
      } else {
        const savedTarget = await createDeployTarget(payload);
        if (savedTarget.nginxSiteManaged) {
          await syncNginxSite(savedTarget.id);
        }
        message.success('部署目标已新增');
      }
      targetModalOpen.value = false;
      await refreshActiveTab({ force: true });
    } catch (error: any) {
      message.error(getErrorMessage(error));
    } finally {
      targetSaving.value = false;
    }
  };

  /**
   * 删除部署目标。
   * @param target 部署目标
   */
  const deleteTarget = async (target: DeployTarget) => {
    if (!ensureLoggedIn()) return;
    if (!(await ensureTargetIdle(target, '删除'))) return;
    await deleteDeployTarget(target.id);
    message.success('部署目标已删除');
    await refreshActiveTab({ force: true });
  };

  /**
   * 同步托管 Nginx 站点配置。
   * @param target 部署目标
   */
  const syncTargetSite = async (target: DeployTarget) => {
    if (!ensureLoggedIn()) return;
    if (!(await ensureTargetIdle(target, '同步站点'))) return;
    await syncNginxSite(target.id);
    message.success('同步托管 Nginx 站点配置成功');
    await refreshActiveTab({ force: true });
  };

  /**
   * 修复历史部署目标与托管 Nginx 实例的绑定关系。
   */
  const repairManagedNginxBindings = async () => {
    if (!ensureLoggedIn()) return;
    targetBindingRepairing.value = true;
    try {
      await refreshServerList();
      const sourceTargets = await listDeployTargets({});
      let updatedCount = 0;

      for (const server of servers.value) {
        const managedInstance = server.nginxInstances?.find((instance) => instance.instanceType === 'managed' && instance.initializedAt) ||
          server.nginxInstances?.find((instance) => instance.instanceType === 'managed');
        if (!managedInstance) continue;

        const serverTargets = sourceTargets.filter((target) => Number(target.serverId) === Number(server.id));
        const mainTargets = serverTargets.filter((target) => isMainDeployProject(target));
        const mainTarget = mainTargets.find((target) => Number(target.nginxInstanceId) === Number(managedInstance.id)) || mainTargets[0];
        if (!mainTarget) continue;

        const mainConfPath = managedInstance.defaultNginxConfPath || `${managedInstance.nginxRoot || '/opt/yuyan/nginx'}/conf/nginx.conf`;
        const mainListenPort = Number(mainTarget.listenPort || managedInstance.portStart || 0);
        const mainVisitUrl = mainTarget.visitUrl || (mainListenPort ? `http://${server.host}:${mainListenPort}` : '');
        const mainPayload: DeployTargetPayload = {
          ...mainTarget,
          nginxInstanceId: managedInstance.id,
          nginxConfPath: mainConfPath,
          nginxSiteManaged: true,
          listenPort: mainListenPort,
          serverName: mainTarget.nginxServerName || '_',
          visitUrl: mainVisitUrl,
          enableNginxTest: true,
          enableNginxReload: true,
          uploadStrategy: mainTarget.uploadStrategy || DEFAULT_UPLOAD_STRATEGY,
        };
        await updateDeployTarget(mainTarget.id, mainPayload);
        await syncNginxSite(mainTarget.id);
        updatedCount += 1;

        for (const target of serverTargets) {
          if (target.id === mainTarget.id) continue;
          if (isMainDeployProject(target)) continue;
          const fallbackMainTarget = findMainManagedSiteTarget([{ ...mainTarget, nginxInstanceId: managedInstance.id, nginxConfPath: mainConfPath, nginxSiteManaged: true }], server.id, managedInstance.id);
          const microPayload: DeployTargetPayload = {
            ...target,
            nginxInstanceId: managedInstance.id,
            nginxConfPath: fallbackMainTarget?.nginxConfPath || mainConfPath,
            nginxSiteManaged: false,
            listenPort: 0,
            serverName: target.nginxServerName || '_',
            enableNginxTest: true,
            enableNginxReload: true,
            uploadStrategy: target.uploadStrategy || DEFAULT_UPLOAD_STRATEGY,
          };
          await updateDeployTarget(target.id, microPayload);
          updatedCount += 1;
        }
      }

      if (!updatedCount) {
        message.warning('未找到可修复的主应用和托管 Nginx 实例');
        return;
      }
      message.success(`已修复 ${updatedCount} 个部署目标的 Nginx 关联`);
      await refreshServerList();
      await refreshActiveTab({ force: true });
    } catch (error: any) {
      message.error(getErrorMessage(error));
    } finally {
      targetBindingRepairing.value = false;
    }
  };

  /** 按当前筛选条件查询部署目标 */
  const handleTargetFilterSearch = async () => {
    await refreshActiveTab({ force: true });
  };

  /** 重置部署目标筛选条件 */
  const handleTargetFilterReset = async () => {
    Object.assign(targetFilterForm, { projectKeyword: '', branch: undefined, serverId: getDefaultTargetServerFilter() });
    await refreshActiveTab({ force: true });
  };

  /** 清空部署目标数据和临时态 */
  const clearTargetData = () => {
    stopTargetRuntimePolling();
    cancelPendingRequests();
    targets.value = [];
    allTargets.value = [];
    targetRuntimeSnapshots.value = {};
    targetRuntimeLoading.value = false;
    Object.assign(targetFilterForm, { projectKeyword: activeProject?.projectName || '', branch: undefined, serverId: undefined });
    activeTargetId.value = null;
    nginxTargetId.value = null;
    targetModalOpen.value = false;
    targetFormLoading.value = false;
  };

  /**
   * 清洗多行命令文本。
   * @param commandText 原始命令文本
   * @returns 去空行后的命令文本
   */
  function normalizeCommandText(commandText?: string): string {
    return String(commandText || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n');
  }

  watch(
    () => targetForm.serverId,
    (serverId) => {
      if (!serverId || initializingTargetForm.value) return;
      const server = servers.value.find((item) => item.id === Number(serverId));
      if (!server) return;
      const nextInstance = getDefaultNginxInstance(server);
      targetForm.nginxInstanceId = nextInstance?.id || 0;
      applyTargetServerDefaults(server, targetForm.projectName, nextInstance);
      void applyManagedNginxDefaults(server, nextInstance);
      syncTargetNginxInstanceFieldState();
    }
  );

  watch(
    () => targetForm.nginxInstanceId,
    (nginxInstanceId, oldNginxInstanceId) => {
      if (initializingTargetForm.value || !targetModalOpen.value || !nginxInstanceId || nginxInstanceId === oldNginxInstanceId) return;
      const server = servers.value.find((item) => item.id === Number(targetForm.serverId));
      const instance = getSelectedNginxInstance(server);
      applyTargetServerDefaults(server, targetForm.projectName, instance);
      void applyManagedNginxDefaults(server, instance);
    }
  );

  watch(
    () => targetForm.projectId,
    (projectId, oldProjectId) => {
      if (initializingTargetForm.value || !targetModalOpen.value || !projectId || projectId === oldProjectId) return;
      if (syncingProjectId.value === Number(projectId)) return;
      void syncTargetProject(Number(projectId));
    },
    { flush: 'sync' }
  );

  watch(projectOptions, () => {
    if (targetModalOpen.value) syncTargetProjectFieldState();
  });

  watch(branchOptions, () => {
    if (targetModalOpen.value) syncTargetBranchFieldState();
  });

  watch(targetServerFilterOptions, () => {
    if (targetModalOpen.value) syncTargetServerFieldState();
  });

  watch(targetNginxInstanceOptions, () => {
    if (targetModalOpen.value) syncTargetNginxInstanceFieldState();
  });

  watch(
    () => targetForm.nginxSiteManaged,
    () => {
      if (targetModalOpen.value) syncTargetNginxSiteManagedState();
    }
  );

  return {
    targetSaving,
    targetBindingRepairing,
    targetFormLoading,
    targets,
    runtimeTargets,
    allTargets,
    targetRuntimeSnapshots,
    targetRuntimeLoading,
    targetFilterForm,
    targetBranchFilterOptions,
    targetServerFilterOptions,
    targetModalOpen,
    activeTargetId,
    nginxTargetId,
    targetFormRef,
    targetForm,
    targetFormModel,
    targetSchema,
    hasProjectContext,
    getTargetRuntimeSnapshot,
    setTargetRuntimeSnapshot,
    clearTargetRuntimeSnapshot,
    refreshTargetRuntimeSnapshots,
    refreshTargetList,
    openCreateTarget,
    openEditTarget,
    saveTarget,
    deleteTarget,
    syncTargetSite,
    repairManagedNginxBindings,
    openNginxConfig,
    handleTargetFilterSearch,
    handleTargetFilterReset,
    handleSaveNginxConf,
    handleTestNginxConf,
    clearTargetData,
  };
}
