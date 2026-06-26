import type { GitLabProject } from '@/api/gitlab';
import type { DeployProjectSource, DeployServer, DeployServerPayload, DeployTarget, NginxInstance } from '@/api/deploy';
import {
  createProjectSelectSearchKey,
  renderProjectSelectOptionLabel,
  renderTwoLineSelectOption,
} from './hooks/useDeployProjectOptions';
import type {
  DeployProjectContext,
  DeployTargetProjectDraft,
  DeployTargetProjectInfo,
  FormilyRef,
  RecordProjectOption,
  RecordServerOption,
} from './types';

/** 可用于判断主应用的项目信息 */
type MainProjectCandidate = {
  projectName?: string;
  projectDescription?: string;
};

/** 系统自动生成的外部 Nginx 实例名称 */
const SYSTEM_NGINX_INSTANCE_NAME = '系统 Nginx';

/**
 * 判断错误是否由主动停止触发。
 * @param error 错误对象
 * @returns 是否主动停止
 */
export const isAbortError = (error: any): boolean => {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
};

/**
 * 判断错误是否为后端发布互斥冲突。
 * @param error 错误对象
 * @returns 是否发布冲突
 */
export const isDeployConflictError = (error: any): boolean => {
  return Number(error?.status || error?.response?.status || 0) === 409;
};

/**
 * 判断错误是否为未找到运行中任务。
 * @param error 错误对象
 * @returns 是否 404
 */
export const isNotFoundError = (error: any): boolean => {
  return Number(error?.status || error?.response?.status || 0) === 404;
};

/**
 * 提取接口错误消息。
 * @param error 错误对象
 * @returns 错误消息
 */
export function getErrorMessage(error: any): string {
  return error?.response?.data?.error || error?.response?.data?.message || error?.message || '操作失败';
}

/**
 * 构建默认服务器表单。
 * @returns 服务器表单初始值
 */
export function createDefaultServerForm(): DeployServerPayload {
  return {
    name: '',
    host: '',
    port: 22,
    username: '',
    authType: 'password',
    password: '',
    privateKey: '',
    passphrase: '',
    useSudo: false,
    defaultDeployRoot: '/opt/yuyan/html',
    defaultNginxConfPath: '/opt/yuyan/nginx/conf/nginx.conf',
    nginxWorkDir: '',
    nginxTestCommand: 'nginx -t',
    nginxReloadCommand: 'nginx -s reload',
    remark: '',
  };
}

/**
 * 获取发布历史项目筛选项值。
 * @param projectInfo 项目信息
 * @returns 筛选项唯一值
 */
export function getRecordProjectOptionValue(projectInfo: DeployTargetProjectInfo) {
  const projectId = Number(projectInfo.projectId || 0);
  const projectPath = String(projectInfo.projectPath || '').trim();
  if (projectId) return `project:${projectId}`;
  return projectPath ? `path:${projectPath}` : '';
}

/**
 * 格式化服务器展示名称。
 * @param name 服务器名称
 * @param host 服务器 IP 或域名
 * @returns 服务器展示文案
 */
export function formatServerLabel(name?: string | null, host?: string | null): string {
  const serverName = String(name || '').trim();
  const serverHost = String(host || '').trim();
  if (serverName && serverHost) return `${serverName}（${serverHost}）`;
  return serverName || serverHost || '-';
}

/**
 * 从已配置部署目标中生成项目筛选项。
 * @param targetList 部署目标列表
 * @returns 发布历史项目筛选项
 */
export function createRecordProjectOptions(targetList: DeployTarget[]): RecordProjectOption[] {
  const optionMap = new Map<string, RecordProjectOption>();
  targetList.forEach((target) => {
    const value = getRecordProjectOptionValue(target);
    if (!value || optionMap.has(value)) return;
    const projectName = target.projectName || target.projectPath || `项目 ${target.projectId}`;
    const description = String(target.projectDescription || target.projectPath || '').trim();
    optionMap.set(value, {
      label: renderProjectSelectOptionLabel({ title: projectName, description }),
      title: projectName,
      description,
      searchKey: createProjectSelectSearchKey({
        id: target.projectId,
        title: projectName,
        description,
        path: target.projectPath,
      }),
      value,
      projectId: target.projectId,
      projectName,
      projectPath: target.projectPath || '',
    });
  });
  return Array.from(optionMap.values());
}

/**
 * 从已配置部署目标中生成发布历史服务器筛选项。
 * @param targetList 部署目标列表
 * @returns 发布历史服务器筛选项
 */
export function createRecordServerOptions(targetList: DeployTarget[]): RecordServerOption[] {
  const optionMap = new Map<number, RecordServerOption>();
  targetList.forEach((target) => {
    const serverId = Number(target.serverId || 0);
    if (!serverId || optionMap.has(serverId)) return;
    const name = target.serverName || `服务器 ${serverId}`;
    const host = target.serverHost || '';
    optionMap.set(serverId, {
      label: renderTwoLineSelectOption({ title: name, description: host }),
      title: name,
      searchKey: `${name} ${host}`,
      value: serverId,
    });
  });
  return Array.from(optionMap.values());
}

/**
 * 从指定服务器的部署目标生成发布历史项目筛选项。
 * @param targetList 部署目标列表
 * @returns 发布历史项目筛选项
 */
export function createRecordTargetOptions(targetList: DeployTarget[]): RecordProjectOption[] {
  return targetList.map((target) => {
    const projectName = target.projectName || target.projectPath || `项目 ${target.projectId}`;
    const descriptionParts = [
      String(target.projectDescription || target.projectPath || '').trim(),
      String(target.deployRoot || '').trim(),
    ].filter(Boolean);
    const description = descriptionParts.join(' · ');
    return {
      label: renderProjectSelectOptionLabel({ title: projectName, description }),
      title: projectName,
      description,
      searchKey: createProjectSelectSearchKey({
        id: target.projectId,
        title: projectName,
        description,
        path: target.projectPath,
      }),
      value: `target:${target.id}`,
      targetId: target.id,
      serverId: target.serverId,
      serverName: target.serverName,
      serverHost: target.serverHost,
      projectId: target.projectId,
      projectName,
      projectPath: target.projectPath || '',
    };
  });
}

/**
 * 从 GitLab 项目生成部署目标项目快照。
 * @param projectInfo GitLab 项目
 * @returns 部署目标项目快照
 */
export function createProjectDraftFromGitLab(projectInfo: GitLabProject, projectSource: DeployProjectSource = 'ops'): DeployTargetProjectDraft {
  return {
    projectSource,
    projectId: projectInfo.id,
    projectName: projectInfo.name,
    projectDescription: projectInfo.description || '',
    projectPath: projectInfo.path_with_namespace || '',
    repositoryUrl: projectInfo.http_url_to_repo || '',
    defaultBranch: projectInfo.default_branch || 'dev',
  };
}

/**
 * 从路由上下文生成部署目标项目快照。
 * @param projectInfo 路由项目上下文
 * @returns 部署目标项目快照
 */
export function createProjectDraftFromContext(projectInfo: DeployProjectContext): DeployTargetProjectDraft {
  return {
    projectSource: 'ops',
    projectId: projectInfo.projectId,
    projectName: projectInfo.projectName,
    projectDescription: projectInfo.projectDescription || '',
    projectPath: projectInfo.projectPath,
    repositoryUrl: projectInfo.repositoryUrl,
    defaultBranch: projectInfo.defaultBranch || 'dev',
  };
}

/**
 * 生成分支下拉选项。
 * @param targetList 部署目标列表
 * @returns 分支选项
 */
export function createBranchOptions(targetList: DeployTarget[]) {
  return Array.from(new Set(targetList.map((target) => target.defaultBranch || 'dev').filter(Boolean))).map((branch) => ({
    label: branch,
    value: branch,
  }));
}

/**
 * 从部署目标中生成服务器筛选项，避免初始化目标页时额外请求服务器管理列表。
 * @param targetList 部署目标列表
 * @returns 服务器筛选项
 */
export function createServerOptionsFromTargets(targetList: DeployTarget[]) {
  const optionMap = new Map<number, any>();
  targetList.forEach((target) => {
    const serverId = Number(target.serverId || 0);
    if (!serverId || optionMap.has(serverId)) return;
    const name = target.serverName || `服务器 ${serverId}`;
    const host = target.serverHost || '';
    optionMap.set(serverId, {
      label: renderTwoLineSelectOption({ title: name, description: host }),
      title: name,
      searchKey: `${name} ${host}`,
      value: serverId,
    });
  });
  return Array.from(optionMap.values());
}

/**
 * 刷新 Formily Select 字段数据源。
 * @param formRef 表单实例
 * @param fieldPath 字段路径
 * @param options 下拉选项
 * @param componentProps 组件属性
 */
export function syncSelectFieldState(formRef: FormilyRef | null, fieldPath: string, options: unknown[], componentProps: Record<string, unknown> = {}) {
  formRef?.setFieldState?.(fieldPath, (state: any) => {
    state.dataSource = options;
    state.componentProps = {
      ...(state.componentProps || {}),
      ...componentProps,
    };
  });
}

/**
 * 判断部署项目是否为拥有独立 Nginx 站点的主应用。
 * @param project 项目或部署目标
 * @returns 是否主应用
 */
export function isMainDeployProject(project: MainProjectCandidate | null | undefined) {
  const text = `${project?.projectName || ''} ${project?.projectDescription || ''}`.toLowerCase();
  return text.includes('主应用');
}

/**
 * 判断是否为历史自动生成的系统 Nginx 实例。
 * @param instance Nginx 实例
 * @returns 是否系统实例
 */
export function isSystemNginxInstance(instance: NginxInstance | null | undefined) {
  return Boolean(instance?.instanceType === 'external' && instance.name === SYSTEM_NGINX_INSTANCE_NAME);
}

/**
 * 判断实例是否应在业务选择中展示。
 * @param instance Nginx 实例
 * @returns 是否展示
 */
export function isVisibleNginxInstance(instance: NginxInstance | null | undefined) {
  if (!instance) return false;
  return !(isSystemNginxInstance(instance) && !Number(instance.targetCount || 0));
}

/**
 * 获取可展示的 Nginx 实例列表。
 * @param server 部署服务器
 * @returns 可展示实例列表
 */
export function getVisibleNginxInstances(server?: DeployServer | null) {
  return (server?.nginxInstances || []).filter(isVisibleNginxInstance);
}

/**
 * 获取默认 Nginx 实例，优先选择托管实例。
 * @param server 部署服务器
 * @returns 默认实例
 */
export function getPreferredNginxInstance(server?: DeployServer | null) {
  if (!server) return undefined;
  const visibleInstances = getVisibleNginxInstances(server);
  const managedInstance =
    visibleInstances.find((instance) => instance.instanceType === 'managed' && instance.initializedAt && instance.status !== 'uninitialized') ||
    visibleInstances.find((instance) => instance.instanceType === 'managed');
  if (managedInstance) return managedInstance;
  return visibleInstances.find((instance) => instance.id === Number(server.defaultNginxInstanceId)) || visibleInstances[0];
}

/**
 * 查找同服务器、同托管实例下的主应用站点目标。
 * @param targetList 部署目标列表
 * @param serverId 服务器 ID
 * @param nginxInstanceId Nginx 实例 ID
 * @returns 主应用站点目标
 */
export function findMainManagedSiteTarget(targetList: DeployTarget[], serverId: number, nginxInstanceId: number) {
  return targetList.find(
    (target) =>
      Number(target.serverId) === Number(serverId) &&
      Number(target.nginxInstanceId) === Number(nginxInstanceId) &&
      target.nginxSiteManaged &&
      isMainDeployProject(target)
  );
}

/**
 * 按服务器模板生成部署路径默认值。
 * @param server 部署服务器
 * @param appName 应用名
 * @param applyTemplate 模板替换函数
 * @param nginxInstance Nginx 实例
 * @param project 当前部署项目
 * @param targetList 已有部署目标列表
 * @returns 默认部署根目录和 Nginx 配置路径
 */
export function createTargetServerDefaults(
  server: DeployServer,
  appName: string,
  applyTemplate: (template: string, appName: string) => string,
  nginxInstance?: NginxInstance,
  project?: MainProjectCandidate,
  targetList: DeployTarget[] = []
) {
  const instance = nginxInstance || getPreferredNginxInstance(server);
  const managed = Boolean(instance?.instanceType === 'managed' && instance.initializedAt && instance.status !== 'uninitialized');
  const hasNginxCommands = Boolean(instance?.nginxTestCommand || instance?.nginxReloadCommand || server.nginxTestCommand || server.nginxReloadCommand);
  const deployRootTemplate = managed ? instance?.htmlRoot || instance?.defaultDeployRoot || '/opt/yuyan/html' : instance?.defaultDeployRoot || server.defaultDeployRoot || '/opt/yuyan/html';
  const mainProject = isMainDeployProject(project);
  const mainSiteTarget = managed && instance ? findMainManagedSiteTarget(targetList, server.id, instance.id) : undefined;
  const nginxConfPath = managed ? instance?.defaultNginxConfPath || mainSiteTarget?.nginxConfPath || `${instance?.nginxRoot || '/opt/yuyan/nginx'}/conf/nginx.conf` : applyTemplate(instance?.defaultNginxConfPath || server.defaultNginxConfPath || '/opt/yuyan/nginx/conf/nginx.conf', appName);
  return {
    nginxInstanceId: instance?.id || 0,
    deployRoot: applyTemplate(deployRootTemplate, appName),
    nginxConfPath,
    nginxSiteManaged: managed && mainProject,
    enableNginxTest: managed || hasNginxCommands,
    enableNginxReload: managed || hasNginxCommands,
    serverName: '_',
  };
}
