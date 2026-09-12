import axios from 'axios';
import {
  deployBackendTargetFromDesktop,
  generateOpenApiFromDesktop,
  getLatestDesktopOpenApi,
  readDesktopOpenApi,
} from '@/api/agent';
import { buildLocalDeployApiUrl } from '@/api/localDeployUrl';

/** 服务器认证方式 */
export type DeployAuthType = 'password' | 'privateKey';

/** 发布状态 */
export type DeployRecordStatus = 'running' | 'success' | 'failed' | 'stopped';

/** 发布记录操作类型 */
export type DeployRecordAction = 'deploy' | 'rollback' | 'undoRollback';

/** 部署项目来源 */
export type DeployProjectSource = 'ops' | 'gitlab';

/** 静态资源上传策略 */
export type DeployUploadStrategy = 'cleanReplace' | 'overlayKeepAssets';

/** 后端服务角色 */
export type BackendServiceRole = 'application' | 'gateway';

/** 后端进程管理模式 */
export type BackendProcessMode = 'pid' | 'systemd' | 'legacy';

/** 后端服务状态 */
export type BackendServiceStatus = 'online' | 'offline' | 'starting' | 'stopping' | 'deploying' | 'error' | 'unknown';

/** Nginx 实例类型 */
export type NginxInstanceType = 'external' | 'managed';

/** 独立服务器配置 */
export interface DeployServer {
  id: number;
  sortOrder: number;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: DeployAuthType;
  useSudo: boolean;
  defaultDeployRoot: string;
  defaultBackendRoot: string;
  defaultNginxConfPath: string;
  nginxWorkDir: string;
  nginxTestCommand: string;
  nginxReloadCommand: string;
  remark: string;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
  defaultNginxInstanceId: number;
  nginxInstances: NginxInstance[];
  nginxRuntime: NginxRuntime | null;
}

/** 部署根目录占用目标摘要 */
export interface DeployRootOccupancy {
  targetId: number;
  projectName: string;
  branch: string;
  envName: string;
}

/** 服务器部署根目录候选 */
export interface DeployRootOption {
  kind: 'root' | 'application';
  name: string;
  path: string;
  exists: boolean;
  hasIndexHtml: boolean;
  occupied: boolean;
  occupiedBy: DeployRootOccupancy[];
}

/** 服务器部署根目录候选响应 */
export interface DeployRootOptionsResult {
  configuredRoot: string;
  nginxInstanceId: number;
  truncated: boolean;
  /** 服务器目录扫描失败时的非阻断提示。 */
  scanWarning?: string;
  items: DeployRootOption[];
}

/** Nginx 发现到的静态根目录状态。 */
export interface NginxDiscoveryRoot {
  path: string;
  exists: boolean;
  readable: boolean;
  hasIndexHtml: boolean;
}

/** Nginx listen 结构化摘要。 */
export interface NginxDiscoveryListen {
  raw: string;
  address: string;
  port: number | null;
  transport: 'tcp' | 'unix';
  ssl: boolean;
  defaultServer: boolean;
  wildcard: boolean;
  loopback: boolean;
}

/** Nginx 站点建议访问地址。 */
export interface NginxDiscoveryAccessEndpoint {
  url: string;
  host: string;
  port: number;
  protocol: 'http' | 'https';
  source: 'serverName' | 'serverHost' | 'listen';
  scope: 'remote' | 'local';
}

/** Nginx 扫描结构化诊断。 */
export interface NginxDiscoveryDiagnostic {
  code: 'binary_unresolved' | 'command_not_found' | 'permission_denied' | 'sudo_password_required' | 'config_invalid' | 'timeout' | 'no_sites' | 'truncated';
  severity: 'info' | 'warning' | 'error';
  scope: 'scan' | 'runtime';
  summary: string;
  detail?: string;
  action?: string;
}

/** Nginx 发现到的 server 站点。 */
export interface NginxDiscoverySite {
  id: string;
  order: number;
  configPath: string;
  listens: NginxDiscoveryListen[];
  accessEndpoints: NginxDiscoveryAccessEndpoint[];
  listenPorts: number[];
  listenValues: string[];
  serverNames: string[];
  roots: NginxDiscoveryRoot[];
  dynamicRoots: string[];
  aliases: string[];
  dynamicAliases: string[];
  type: 'static' | 'mixed' | 'proxy' | 'unknown';
  hasProxyPass: boolean;
  warnings: string[];
}

/** 宿主机 Nginx 运行实例发现结果。 */
export interface NginxDiscoveryRuntime {
  id: string;
  binaryPath: string;
  binaryResolution: 'resolved' | 'unresolved';
  inspectionState: 'ready' | 'partial' | 'unavailable';
  runtimeFingerprint: string;
  version: string;
  masterPids: number[];
  running: boolean;
  prefix: string;
  mainConfigPath: string;
  nginxWorkDir: string;
  nginxTestCommand: string;
  nginxReloadCommand: string;
  useSudo: boolean;
  connectedInstanceId: number | null;
  connectedInstance: Pick<NginxInstance, 'id' | 'name'> | null;
  diagnostics: NginxDiscoveryDiagnostic[];
  warnings: string[];
  sites: NginxDiscoverySite[];
}

/** 宿主机 Nginx 智能发现响应。 */
export interface NginxDiscoveryResult {
  server: { id: number; name: string; host: string; sshPort: number };
  scannedAt: string;
  durationMs: number;
  useSudo: boolean;
  runtimes: NginxDiscoveryRuntime[];
  diagnostics: NginxDiscoveryDiagnostic[];
  warnings: string[];
  truncated: boolean;
}

/** 独立服务器保存参数 */
export interface DeployServerPayload {
  name: string;
  host: string;
  port: number;
  username: string;
  authType: DeployAuthType;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  useSudo?: boolean;
  defaultDeployRoot?: string;
  defaultBackendRoot?: string;
  defaultNginxConfPath?: string;
  nginxWorkDir?: string;
  nginxTestCommand?: string;
  nginxReloadCommand?: string;
  remark?: string;
}

/** 部署配置 */
export interface DeployTarget {
  id: number;
  projectSource: DeployProjectSource;
  projectId: number;
  projectName: string;
  projectDescription: string;
  projectPath: string;
  repositoryUrl: string;
  defaultBranch: string;
  envName: string;
  serverId: number;
  serverName: string;
  serverHost: string;
  nginxInstanceId: number;
  nginxInstanceName: string;
  nginxInstanceType: NginxInstanceType | '';
  deployRoot: string;
  nginxConfPath: string;
  nginxSiteManaged: boolean;
  listenPort: number;
  nginxServerName: string;
  enableNginxTest: boolean;
  enableNginxReload: boolean;
  installCommand: string;
  buildCommand: string;
  artifactDir: string;
  preserveSubDirs: string;
  uploadStrategy: DeployUploadStrategy;
  visitUrl: string;
  remark?: string;
  createdAt: string;
  updatedAt: string;
  projectType: 'frontend' | 'backend';
  jdkId?: number;
  stopCommand?: string;
  startCommand?: string;
  healthCheckUrl?: string;
  serviceRole: BackendServiceRole;
  environmentId: number;
  environmentName: string;
  serviceName: string;
  buildJdkId: number;
  requiredJdkAlias: string;
  serverJavaRuntimeId: number;
  runtimeJavaHome: string;
  runtimeJavaVersion: string;
  serverPort: number;
  springProfiles: string;
  externalConfigPath: string;
  jvmOptions: string;
  appArgs: string;
  processMode: BackendProcessMode;
  stopTimeoutSeconds: number;
  startupTimeoutSeconds: number;
  healthCheckPath: string;
  nacosServerAddr: string;
  nacosConsoleUrl: string;
  nacosNamespace: string;
  nacosGroup: string;
  nacosStatus: 'online' | 'offline' | 'unknown' | 'unconfigured';
  requireNacosRegistration: boolean;
  gatewayUrl: string;
  gatewayProbePath: string;
  artifactPattern: string;
  openapiCommand: string;
  openapiOutputPath: string;
  backendTemplate?: string;
  needsReview: boolean;
  serviceStatus: BackendServiceStatus;
  serviceStatusOutput: string;
  serviceStatusAt: string;
  directUrl: string;
}

/** 部署目标保存参数 */
export interface DeployTargetPayload {
  projectSource: DeployProjectSource;
  projectId: number;
  projectName: string;
  projectDescription?: string;
  projectPath: string;
  repositoryUrl: string;
  defaultBranch: string;
  envName: string;
  serverId: number;
  nginxInstanceId: number;
  deployRoot: string;
  nginxConfPath: string;
  nginxSiteManaged?: boolean;
  listenPort?: number;
  serverName?: string;
  enableNginxTest: boolean;
  enableNginxReload: boolean;
  installCommand: string;
  buildCommand: string;
  artifactDir: string;
  preserveSubDirs?: string;
  uploadStrategy?: DeployUploadStrategy;
  visitUrl?: string;
  remark?: string;
  projectType?: 'frontend' | 'backend';
  jdkId?: number;
  stopCommand?: string;
  startCommand?: string;
  healthCheckUrl?: string;
  serviceRole?: BackendServiceRole;
  environmentId?: number;
  serviceName?: string;
  buildJdkId?: number;
  requiredJdkAlias?: string;
  serverJavaRuntimeId?: number;
  runtimeJavaHome?: string;
  runtimeJavaVersion?: string;
  serverPort?: number;
  springProfiles?: string;
  externalConfigPath?: string;
  jvmOptions?: string;
  appArgs?: string;
  processMode?: BackendProcessMode;
  stopTimeoutSeconds?: number;
  startupTimeoutSeconds?: number;
  healthCheckPath?: string;
  nacosServerAddr?: string;
  nacosConsoleUrl?: string;
  nacosNamespace?: string;
  nacosGroup?: string;
  requireNacosRegistration?: boolean;
  gatewayUrl?: string;
  gatewayProbePath?: string;
  artifactPattern?: string;
  openapiCommand?: string;
  openapiOutputPath?: string;
  backendTemplate?: string;
  needsReview?: boolean;
}

/** OpenAPI 产物元数据 */
export interface OpenApiArtifact {
  id: string | number;
  targetId: number;
  projectName: string;
  branch: string;
  commitSha: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  status: 'success';
  generatedAt: string;
}

/** 后端项目检测结果 */
export interface BackendProjectInspection {
  javaVersion: string;
  javaMajorVersion: number;
  starterPom: string;
  starterModule: string;
  applicationName: string;
  serverPort: number;
  springProfiles: string;
  bootstrapFiles: string[];
  healthCheckPath: string;
  buildCommand: string;
  artifactPattern: string;
  openapiCommand: string;
  openapiOutputPath: string;
  branch: string;
  commitSha: string;
}

/** 后端服务状态响应 */
export interface BackendServiceRuntimeStatus {
  targetId: number;
  status: BackendServiceStatus;
  output: string;
  processMode: Exclude<BackendProcessMode, 'legacy'>;
  directUrl?: string;
  gatewayUrl?: string;
  nacosConsoleUrl?: string;
  nacosStatus?: 'online' | 'offline' | 'unknown' | 'unconfigured';
  checkedAt: string;
}

/** 服务器 Java 运行时 */
export interface ServerJavaRuntime {
  id: number;
  serverId: number;
  name: string;
  homePath: string;
  javaVersion: string;
  majorVersion: number;
  vendor: string;
  arch: string;
  status: 'unknown' | 'available' | 'unavailable';
  statusOutput: string;
  lastCheckedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** 后端共享环境依赖配置 */
export interface DeployEnvironment {
  id: number;
  name: string;
  nacosServerAddr: string;
  nacosConsoleUrl: string;
  nacosNamespace: string;
  nacosGroup: string;
  gatewayTargetId: number;
  gatewayPublicUrl: string;
  status: 'unknown' | 'online' | 'offline' | 'error';
  statusOutput: string;
  lastCheckedAt: string;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 后端共享环境保存参数 */
export interface DeployEnvironmentPayload {
  name: string;
  nacosServerAddr?: string;
  nacosConsoleUrl?: string;
  nacosNamespace?: string;
  nacosGroup?: string;
  username?: string;
  password?: string;
  token?: string;
  gatewayTargetId?: number;
  gatewayPublicUrl?: string;
}

/** 发布日志项 */
export interface DeployLogItem {
  level: 'info' | 'success' | 'warn' | 'error';
  message: string;
  stage?: string;
  timestamp: string;
}

/** 发布记录 */
export interface DeployRecord {
  id: number;
  targetId: number;
  projectId: number;
  projectName: string;
  projectType: 'frontend' | 'backend';
  serverId?: number;
  serverName?: string;
  serverHost?: string;
  envName: string;
  branch: string;
  commitSha: string;
  commitMessage: string;
  commitAuthor: string;
  status: DeployRecordStatus;
  releasePath: string;
  backupPath: string;
  action: DeployRecordAction;
  sourceRecordId: number;
  restoredRecordId: number;
  backupRecordId: number;
  isCurrentVersion: boolean;
  canRollback: boolean;
  canUndoRollback: boolean;
  logs: DeployLogItem[];
  operator: string;
  startedAt: string;
  finishedAt: string;
  projectDescription?: string;
  projectPath?: string;
  repositoryUrl?: string;
}

/** 发布记录分页结果 */
export interface DeployRecordPage {
  items: DeployRecord[];
  total: number;
  page: number;
  pageSize: number;
}

/** 发布记录查询参数 */
export interface DeployRecordQuery {
  projectId?: number;
  projectPath?: string;
  projectName?: string;
  branch?: string;
  operator?: string;
  action?: string;
  targetId?: number;
  serverId?: number;
  projectType?: 'frontend' | 'backend';
  page?: number;
  pageSize?: number;
}

/** 部署目标查询参数 */
export interface DeployTargetQuery {
  projectId?: number;
  projectPath?: string;
  projectName?: string;
  projectKeyword?: string;
  branch?: string;
  serverId?: number;
  projectType?: string;
}

/** 流式发布事件 */
export type DeployTaskResult = DeployRecord | OpenApiArtifact | BackendServiceRuntimeStatus;

export type DeployProgressEvent =
  | { type: 'stage'; stage: string; percent: number; message: string; detail?: string; timestamp: string }
  | { type: 'log'; level: DeployLogItem['level']; stage?: string; message: string; timestamp: string }
  | { type: 'result'; data: DeployTaskResult; timestamp: string }
  | { type: 'error'; stage?: string; message: string; timestamp: string };

/** 流式发布配置 */
export interface DeployProgressOptions {
  signal?: AbortSignal;
  onEvent?: (event: DeployProgressEvent) => void;
}

/** 托管 Nginx 初始化进度配置 */
export interface NginxRuntimeProgressOptions {
  signal?: AbortSignal;
  onEvent?: (event: DeployProgressEvent) => void;
}

/** 运行中的发布任务快照 */
export interface DeployProgressSnapshot {
  operationId?: string;
  targetId: number;
  action: 'deploy' | 'rollback' | 'undoRollback' | 'openapi' | 'start' | 'stop' | 'restart';
  operator: string;
  startedAt: string;
  currentStage: string;
  running: boolean;
  result: DeployTaskResult | null;
  error: string | null;
  events: DeployProgressEvent[];
  maxConcurrent: number;
  runningCount: number;
}

/** 当前团队运行中部署目标的聚合快照。 */
export interface DeployRuntimeSnapshotBatch {
  items: DeployProgressSnapshot[];
  checkedAt: string;
}

interface CentralDeployOperation {
  id: string;
  status: 'uploading' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
  actor?: { accountId: string };
  result?: { progress?: { stage: string; percent: number; message: string }; record?: DeployRecord };
  error?: { message: string };
  createdAt: string;
}

/** 将中央任务映射为既有部署进度快照。 */
function mapCentralDeployOperation(operation: CentralDeployOperation, targetId: number): DeployProgressSnapshot {
  const progress = operation.result?.progress;
  const running = ['uploading', 'queued', 'running'].includes(operation.status);
  return {
    operationId: operation.id,
    targetId,
    action: 'deploy',
    operator: operation.actor?.accountId || '当前账号',
    startedAt: operation.createdAt,
    currentStage: progress?.stage || operation.status,
    running,
    result: operation.result?.record || null,
    error: operation.error?.message || null,
    events: progress ? [{ type: 'stage', ...progress, timestamp: new Date().toISOString() }] : [],
    maxConcurrent: 1,
    runningCount: running ? 1 : 0,
  };
}

/** 托管 Nginx 运行时 */
export interface NginxRuntime {
  id: number;
  serverId: number;
  baseRoot: string;
  nginxRoot: string;
  htmlRoot: string;
  sitesDir: string;
  logsDir: string;
  scriptPath: string;
  portStart: number;
  useSudo: boolean;
  runtimeVersion: string;
  packageSha256: string;
  packageVariant: string;
  status: 'unknown' | 'uninitialized' | 'running' | 'stopped' | 'error';
  statusOutput: string;
  initializedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** Nginx 实例 */
export interface NginxInstance {
  id: number;
  serverId: number;
  name: string;
  instanceType: NginxInstanceType;
  runtimeFingerprint?: string;
  defaultDeployRoot: string;
  defaultNginxConfPath: string;
  nginxWorkDir: string;
  nginxTestCommand: string;
  nginxReloadCommand: string;
  baseRoot: string;
  nginxRoot: string;
  htmlRoot: string;
  sitesDir: string;
  logsDir: string;
  scriptPath: string;
  portStart: number;
  useSudo: boolean;
  runtimeVersion: string;
  packageSha256: string;
  packageVariant: string;
  status: NginxRuntime['status'];
  statusOutput: string;
  initializedAt: string;
  targetCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Nginx 实例保存参数 */
export interface NginxInstancePayload {
  name: string;
  instanceType: NginxInstanceType;
  runtimeFingerprint?: string;
  defaultDeployRoot?: string;
  defaultNginxConfPath?: string;
  nginxWorkDir?: string;
  nginxTestCommand?: string;
  nginxReloadCommand?: string;
  baseRoot?: string;
  portStart?: number;
  useSudo?: boolean;
}

/** 托管 Nginx 初始化参数 */
export interface NginxRuntimePayload {
  baseRoot: string;
  portStart: number;
  useSudo: boolean;
}

/** 托管 Nginx 运行时状态 */
export interface NginxRuntimeStatus {
  runtime: NginxRuntime | NginxInstance | null;
  initialized: boolean;
  running: boolean;
  status: NginxRuntime['status'];
  statusOutput: string;
  platform: string;
  manifest: Record<string, unknown> | null;
  manifests?: Record<string, unknown>[];
  version: string;
  packageVariant: string;
  baseRoot: string;
  installRoot: string;
  sitesDir: string;
  webRoot: string;
  scriptPath: string;
  mainConfPath: string;
  portStart: number;
}

/** 托管 Nginx 操作 */
export type NginxRuntimeAction = 'test' | 'start' | 'stop' | 'reload' | 'status';

/** 托管 Nginx 运行包下载类型 */
export type NginxArchiveDownloadType = 'all' | 'html' | 'conf';

/** Nginx 归档可选 server 块。 */
export interface NginxArchiveSiteOption {
  id: string;
  order: number;
  listenPorts: number[];
  listenValues: string[];
  roots: string[];
  serverNames: string[];
  targetIds: number[];
  projectNames: string[];
  canDownloadFiles: boolean;
}

/** Nginx 归档站点预览响应。 */
export interface NginxArchiveSitesResponse {
  configPath: string;
  revision: string;
  sites: NginxArchiveSiteOption[];
}

/** Nginx 归档选择参数。 */
export interface NginxArchiveSelection {
  type: NginxArchiveDownloadType;
  siteIds: string[];
  revision: string;
}

/** 原生文件下载实时进度。 */
export interface NativeFileDownloadProgress {
  stage: 'connecting' | 'writing' | 'finished';
  loadedBytes: number;
  totalBytes?: number | null;
  fileName?: string | null;
}

/** 原生文件下载真实落盘结果。 */
export interface NativeFileDownloadResult {
  path: string;
  fileName: string;
  fileSize: number;
  sha256: string;
}

/** 托管 Nginx 操作结果 */
export interface NginxRuntimeActionResult {
  success: boolean;
  action: NginxRuntimeAction;
  output: string;
  status: NginxRuntimeStatus;
}

/** 托管 Nginx 实例运行包下载结果 */
export interface NginxInstanceArchiveDownload {
  blob: Blob;
  fileName: string;
  baseRoot: string;
  scriptPath: string;
}

/** 托管 Nginx 站点同步结果 */
export interface NginxSiteSyncResult {
  success: boolean;
  path: string;
  backupPath: string;
  testOutput: string;
  reloadOutput: string;
}

/** 执行发布参数 */
export interface DeployTargetPublishPayload {
  /** 发布分支 */
  branch: string;
  /** GitLab Token */
  gitlabToken?: string;
  /** 操作人 */
  operator?: string;
  /** 是否强制重新安装依赖 */
  forceInstallDependencies?: boolean;
}

import { getApiBase, isTauri } from '@/utils/env';
import { getCachedSecureAccount } from '@/services/secureAuth';

const client = axios.create();

/** 获取服务器模式部署 API Token。 */
export const getDeployApiToken = (): string => {
  return '';
};

/**
 * 判断缓存中的中央访问会话是否仍然可用。
 * @param session - 当前安全账号
 * @returns 是否可以调用中央 v2 API
 */
function hasUsableCentralSession(session: ReturnType<typeof getCachedSecureAccount>): boolean {
  return Boolean(
    session?.accessToken
    && session.teamId
    && Number.isFinite(Date.parse(session.accessExpiresAt))
    && Date.parse(session.accessExpiresAt) > Date.now()
  );
}

/**
 * 获取部署 API 通用请求头；无中央会话时回退为网页 PAT 鉴权。
 * @returns 部署 API 请求头
 */
export const getDeployApiAuthHeaders = (): Record<string, string> => {
  const session = getCachedSecureAccount();
  const headers: Record<string, string> = {
    'Cache-Control': 'no-cache, no-store',
    Pragma: 'no-cache',
  };

  if (session?.gitlabToken && session?.gitlabHost) {
    if (!hasUsableCentralSession(session)) {
      return {
        ...headers,
        'X-Yuyan-Client': 'web',
        'X-GitLab-Token': session.gitlabToken,
        'X-GitLab-Host': session.gitlabHost,
      };
    }
    return {
      ...headers,
      Authorization: `Bearer ${session.accessToken}`,
      'X-Yuyan-Team-Id': session.teamId,
      'X-Yuyan-Client': 'desktop',
      'X-GitLab-Token': session.gitlabToken,
      'X-GitLab-Host': session.gitlabHost,
    };
  }

  if (!import.meta.env.DEV) return headers;
  const devTeamId = String(import.meta.env.VITE_DEV_TEAM_ID || '').trim();
  const devAccessToken = String(import.meta.env.VITE_DEV_ACCESS_TOKEN || '').trim();

  if (devTeamId) {
    headers['X-Yuyan-Team-Id'] = devTeamId;
  }
  if (devAccessToken) {
    headers.Authorization = `Bearer ${devAccessToken}`;
  }
  if (devTeamId && devAccessToken) {
    headers['X-Yuyan-Client'] = 'desktop';
  }

  return headers;
};

client.interceptors.request.use(async (config) => {
  config.baseURL = await getActiveDeployApiBase();
  Object.assign(config.headers, getDeployApiAuthHeaders());
  return config;
});

/** 提取 API 数据 */
const unwrap = <T>(response: { data: { data: T } }) => response.data.data;

/** 获取服务器列表 */
export const listDeployServers = () => client.get('/servers').then(unwrap<DeployServer[]>);

/**
 * 保存部署服务器顺序。
 * @param serverIds 排序后的服务器 ID
 * @returns 排序后的服务器列表
 */
export const reorderDeployServers = (serverIds: number[]) =>
  client.post('/servers/reorder', { serverIds }).then(unwrap<DeployServer[]>);

/** 创建服务器 */
export const createDeployServer = (payload: DeployServerPayload) => client.post('/servers', payload).then(unwrap<DeployServer>);

/** 更新服务器 */
export const updateDeployServer = (id: number, payload: DeployServerPayload) => client.put(`/servers/${id}`, payload).then(unwrap<DeployServer>);

/** 删除服务器 */
export const deleteDeployServer = (id: number, expectedName: string) => client.delete(`/servers/${id}`, { params: { expectedName } });

/** 测试服务器连接 */
export const testDeployServer = (id: number) => client.post(`/servers/${id}/test`).then(unwrap<{ success: boolean; output: string }>);

/**
 * 获取服务器前端部署根目录候选。
 * @param serverId 服务器 ID
 * @param params Nginx 实例与编辑目标参数
 * @returns 服务器应用目录候选
 */
export const getDeployRootOptions = (
  serverId: number,
  params: { nginxInstanceId?: number; excludeTargetId?: number } = {}
) => client.get(`/servers/${serverId}/deploy-root-options`, { params }).then(unwrap<DeployRootOptionsResult>);

/**
 * 只读发现服务器宿主机 Nginx 与前端站点。
 * @param serverId 服务器 ID
 * @param useSudo 是否使用非交互 sudo
 * @param signal 取消信号
 * @returns Nginx 运行实例与站点候选
 */
export const discoverServerNginx = (serverId: number, useSudo: boolean, signal?: AbortSignal) =>
  client.get(`/servers/${serverId}/nginx-discovery`, { params: { useSudo: useSudo ? 1 : 0 }, signal }).then(unwrap<NginxDiscoveryResult>);

/** 获取服务器 Nginx 实例列表 */
export const listNginxInstances = (serverId: number) => client.get(`/servers/${serverId}/nginx-instances`).then(unwrap<NginxInstance[]>);

/** 创建 Nginx 实例 */
export const createNginxInstance = (serverId: number, payload: NginxInstancePayload) =>
  client.post(`/servers/${serverId}/nginx-instances`, payload).then(unwrap<NginxInstance>);

/** 更新 Nginx 实例 */
export const updateNginxInstance = (id: number, payload: NginxInstancePayload) => client.put(`/nginx-instances/${id}`, payload).then(unwrap<NginxInstance>);

/** 删除 Nginx 实例 */
export const deleteNginxInstance = (id: number) => client.delete(`/nginx-instances/${id}`);

/** 获取 Nginx 实例运行状态 */
export const getNginxInstanceStatus = (id: number) => client.get(`/nginx-instances/${id}/status`).then(unwrap<NginxRuntimeStatus>);

/** 获取托管 Nginx 运行时状态 */
export const getNginxRuntimeStatus = (serverId: number) => client.get(`/servers/${serverId}/nginx-runtime`).then(unwrap<NginxRuntimeStatus>);

/** 初始化托管 Nginx 运行时 */
export const initNginxRuntime = (serverId: number, payload: NginxRuntimePayload) =>
  client.post(`/servers/${serverId}/nginx-runtime/init`, payload).then(unwrap<NginxRuntimeStatus>);

/** 流式初始化托管 Nginx 运行时 */
export async function initNginxRuntimeWithProgress(serverId: number, payload: NginxRuntimePayload, options: NginxRuntimeProgressOptions = {}) {
  const response = await fetch(await getActiveDeployApiUrl(`/servers/${serverId}/nginx-runtime/init?stream=1`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', ...getDeployApiAuthHeaders() },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  if (!response.ok) {
    const data = await parseJsonOrText(response);
    throw new Error(typeof data === 'string' ? data : data?.error || data?.message || '初始化 Nginx 失败');
  }
  if (!response.body) {
    const data = await parseJsonOrText(response);
    return data?.data as NginxRuntimeStatus;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: NginxRuntimeStatus | null = null;

  const consumeLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) return;
    const event = JSON.parse(line) as DeployProgressEvent & { data?: NginxRuntimeStatus };
    options.onEvent?.(event);
    if (event.type === 'result') result = event.data || null;
    if (event.type === 'error') throw new Error(event.message || '初始化 Nginx 失败');
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      consumeLine(rawLine);
      newlineIndex = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeLine(buffer);
  if (!result) throw new Error('初始化 Nginx 未返回状态');
  return result;
}

/** 流式初始化 Nginx 实例 */
export async function initNginxInstanceWithProgress(instanceId: number, payload: NginxRuntimePayload, options: NginxRuntimeProgressOptions = {}) {
  const response = await fetch(await getActiveDeployApiUrl(`/nginx-instances/${instanceId}/init?stream=1`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', ...getDeployApiAuthHeaders() },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  if (!response.ok) {
    const data = await parseJsonOrText(response);
    throw new Error(typeof data === 'string' ? data : data?.error || data?.message || '初始化 Nginx 失败');
  }
  if (!response.body) {
    const data = await parseJsonOrText(response);
    return data?.data as NginxRuntimeStatus;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: NginxRuntimeStatus | null = null;

  const consumeLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) return;
    const event = JSON.parse(line) as DeployProgressEvent & { data?: NginxRuntimeStatus };
    options.onEvent?.(event);
    if (event.type === 'result') result = event.data || null;
    if (event.type === 'error') throw new Error(event.message || '初始化 Nginx 失败');
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      consumeLine(rawLine);
      newlineIndex = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeLine(buffer);
  if (!result) throw new Error('初始化 Nginx 未返回状态');
  return result;
}

/** 执行托管 Nginx 运行时操作 */
export const runNginxRuntimeAction = (serverId: number, action: NginxRuntimeAction) =>
  client.post(`/servers/${serverId}/nginx-runtime/${action}`).then(unwrap<NginxRuntimeActionResult>);

/** 执行 Nginx 实例操作 */
export const runNginxInstanceAction = (instanceId: number, action: NginxRuntimeAction) =>
  client.post(`/nginx-instances/${instanceId}/actions/${action}`).then(unwrap<NginxRuntimeActionResult>);

/**
 * 构建托管 Nginx 实例运行包浏览器直连下载地址。
 * @param instanceId Nginx 实例 ID
 * @param type 下载类型
 * @returns 运行包下载 URL
 */
export const getNginxInstanceArchiveDownloadUrl = async (
  instanceId: number,
  type: NginxArchiveDownloadType = 'all',
  selection?: Pick<NginxArchiveSelection, 'siteIds' | 'revision'>
) => {
  const query = new URLSearchParams({ type });
  if (selection?.siteIds?.length) query.set('siteIds', selection.siteIds.join(','));
  if (selection?.revision) query.set('revision', selection.revision);
  return getActiveDeployApiUrl(`/nginx-instances/${instanceId}/archive?${query.toString()}`);
};

/**
 * 获取托管 Nginx 主配置中的归档站点选项。
 * @param instanceId Nginx 实例 ID
 * @returns 配置版本与可选 server 列表
 */
export async function getNginxInstanceArchiveSites(instanceId: number): Promise<NginxArchiveSitesResponse> {
  const url = await getActiveDeployApiUrl(`/nginx-instances/${instanceId}/archive-sites`);
  return axios.get(url, { headers: getDeployApiAuthHeaders() }).then(unwrap<NginxArchiveSitesResponse>);
}

/**
 * 下载托管 Nginx 实例运行包。
 * @param instanceId Nginx 实例 ID
 * @param type 下载类型
 * @param onProgress 下载进度回调（已下载字节数）
 * @returns 运行包 Blob 与响应元信息
 */
export async function downloadNginxInstanceArchive(
  instanceId: number,
  type: NginxArchiveDownloadType = 'all',
  onProgress?: (loaded: number) => void,
  signal?: AbortSignal,
  selection?: Pick<NginxArchiveSelection, 'siteIds' | 'revision'>
): Promise<NginxInstanceArchiveDownload> {
  const response = await fetch(await getNginxInstanceArchiveDownloadUrl(instanceId, type, selection), {
    signal,
    headers: getDeployApiAuthHeaders(),
  });
  if (!response.ok) {
    const data = await parseJsonOrText(response);
    const errorMessage = typeof data === 'string'
      ? data
      : typeof data?.error === 'string'
        ? data.error
        : data?.error?.message || data?.message || '下载运行包失败';
    throw new Error(errorMessage);
  }

  const reader = response.body?.getReader();
  let blob: Blob;

  if (reader) {
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.length;
        onProgress?.(loaded);
      }
    }
    blob = new Blob(chunks, { type: response.headers.get('Content-Type') || 'application/octet-stream' });
  } else {
    blob = await response.blob();
  }
  if (blob.size <= 0) throw new Error('中央服务返回了空文件，下载未保存');

  return {
    blob,
    fileName: parseDownloadFileName(response.headers.get('Content-Disposition'), `nginx-instance-${instanceId}.tar.gz`),
    baseRoot: decodeResponseHeader(response.headers.get('X-Nginx-Base-Root')),
    scriptPath: decodeResponseHeader(response.headers.get('X-Nginx-Script-Path')),
  };
}

/** 获取托管 Nginx 下一个可用端口 */
export const getNextNginxRuntimePort = (serverId: number, excludeTargetId = 0) =>
  client.get(`/servers/${serverId}/nginx-runtime/next-port`, { params: excludeTargetId ? { excludeTargetId } : undefined }).then(unwrap<{ port: number }>);

/** 获取 Nginx 实例下一个可用端口 */
export const getNextNginxInstancePort = (instanceId: number, excludeTargetId = 0) =>
  client.get(`/nginx-instances/${instanceId}/next-port`, { params: excludeTargetId ? { excludeTargetId } : undefined }).then(unwrap<{ port: number }>);

/** 获取部署目标列表 */
export const listDeployTargets = (params?: DeployTargetQuery) => client.get('/targets', { params }).then(unwrap<DeployTarget[]>);

/** 创建部署目标 */
export const createDeployTarget = (payload: DeployTargetPayload) => client.post('/targets', payload).then(unwrap<DeployTarget>);

/** 更新部署目标 */
export const updateDeployTarget = (id: number, payload: DeployTargetPayload) => client.put(`/targets/${id}`, payload).then(unwrap<DeployTarget>);

/** 删除部署目标 */
export const deleteDeployTarget = (id: number, expectedName: string) => client.delete(`/targets/${id}`, { params: { expectedName } });

/** 获取中央 API 的发布记录列表。 */
export const listDeployRecords = (params?: DeployRecordQuery, gitlabToken = '', gitlabHost = '') =>
  client
    .get('/records', { params, headers: gitlabToken ? { 'X-GitLab-Token': gitlabToken, 'X-GitLab-Host': gitlabHost } : undefined })
    .then(unwrap<DeployRecordPage>);

/** 获取中央 API 的发布记录详情。 */
export const getDeployRecord = (recordId: number, gitlabToken = '', gitlabHost = '') =>
  client
    .get(`/records/${recordId}`, { headers: gitlabToken ? { 'X-GitLab-Token': gitlabToken, 'X-GitLab-Host': gitlabHost } : undefined })
    .then(unwrap<DeployRecord>);

/** 读取 Nginx 配置文件 */
export const readNginxConf = (targetId: number) => client.get(`/targets/${targetId}/nginx-conf`).then(unwrap<{ path: string; content: string }>);

/** 保存 Nginx 配置文件 */
export const saveNginxConf = (targetId: number, content: string, reload = true) =>
  client.put(`/targets/${targetId}/nginx-conf`, { content, reload }).then(unwrap<{ backupPath: string; testOutput: string }>);

/** 测试 Nginx 配置文件 */
export const testNginxConf = (targetId: number) => client.post(`/targets/${targetId}/nginx-test`).then(unwrap<{ output: string }>);

/** 同步托管 Nginx 站点配置 */
export const syncNginxSite = (targetId: number) => client.post(`/targets/${targetId}/nginx-site/sync`).then(unwrap<NginxSiteSyncResult>);

/**
 * 获取部署目标运行中的发布进度快照。
 * @param targetId 部署目标 ID
 * @param projectType 项目类型
 * @returns 发布任务进度快照
 */
export async function getTargetDeployProgress(
  targetId: number,
  projectType: DeployTarget['projectType'],
  signal?: AbortSignal,
) {
  if (projectType === 'backend') {
    const data = await client.get('/operations', {
      params: { targetId, status: 'uploading,queued,running', limit: 1 },
      signal,
    }).then(unwrap<{ items: CentralDeployOperation[] }>);
    const operation = data.items[0];
    if (!operation) {
      const error = new Error('当前后端目标没有运行中的中央任务') as Error & { response?: { status: number } };
      error.response = { status: 404 };
      throw error;
    }
    return mapCentralDeployOperation(operation, targetId);
  }
  const url = await getTargetExecutionApiUrl(`/targets/${targetId}/deploy-progress`, projectType);
  return axios.get(url, { headers: getDeployApiAuthHeaders(), signal }).then(unwrap<DeployProgressSnapshot>);
}

/** 获取当前团队全部运行中部署目标的聚合快照。 */
export const listDeployTargetRuntimeSnapshots = (signal?: AbortSignal) =>
  client.get('/targets/runtime-snapshots', { signal }).then(unwrap<DeployRuntimeSnapshotBatch>);

/**
 * 停止部署目标运行中的发布任务。
 * @param targetId 部署目标 ID
 * @param projectType 项目类型
 * @param payload 停止操作附带上下文（操作人与角色）
 * @returns 停止后的发布任务快照
 */
export async function stopTargetDeploy(
  targetId: number,
  projectType: DeployTarget['projectType'],
  payload?: { operator?: string; role?: string }
) {
  if (projectType === 'backend') {
    const snapshot = await getTargetDeployProgress(targetId, projectType);
    const operation = await client.post(`/operations/${snapshot.operationId}/cancel`, payload).then(unwrap<CentralDeployOperation>);
    return mapCentralDeployOperation(operation, targetId);
  }
  const url = await getTargetExecutionApiUrl(`/targets/${targetId}/deploy/stop`, projectType);
  return axios.post(url, payload, { headers: getDeployApiAuthHeaders() }).then(unwrap<DeployProgressSnapshot>);
}

/** 检测后端项目配置 */
export const inspectBackendTarget = (targetId: number, branch?: string, gitlabToken = '') =>
  client
    .post(`/targets/${targetId}/inspect`, { branch }, { headers: gitlabToken ? { 'X-GitLab-Token': gitlabToken } : undefined })
    .then(unwrap<BackendProjectInspection>);

/** 获取后端服务真实状态 */
export const getBackendServiceStatus = (targetId: number) =>
  client.get(`/targets/${targetId}/service-status`).then(unwrap<BackendServiceRuntimeStatus>);

/** 执行后端服务启停 */
export const runBackendServiceAction = (targetId: number, action: 'start' | 'stop' | 'restart') =>
  client.post(`/targets/${targetId}/service-actions/${action}`).then(unwrap<BackendServiceRuntimeStatus>);

/** 执行后端服务启停并订阅实时进度 */
export async function runBackendServiceActionWithProgress(
  targetId: number,
  action: 'start' | 'stop' | 'restart',
  options: DeployProgressOptions = {}
): Promise<BackendServiceRuntimeStatus> {
  const response = await fetch(await getActiveDeployApiUrl(`/targets/${targetId}/service-actions/${action}?stream=1`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', ...getDeployApiAuthHeaders() },
    body: JSON.stringify({}),
    signal: options.signal,
  });
  return consumeProgressStream<BackendServiceRuntimeStatus>(response, options);
}

/** 获取后端服务日志 */
export const getBackendServiceLogs = (targetId: number, lines = 500) =>
  client.get(`/targets/${targetId}/service-logs`, { params: { lines } }).then(unwrap<{ content: string; lines: number; path: string }>);

/** 获取目标最新 OpenAPI 元数据 */
export const getLatestTargetOpenApi = (targetId: number, branch?: string) =>
  getLatestDesktopOpenApi(targetId, branch) as Promise<OpenApiArtifact>;

/** 读取 OpenAPI 内容 */
export const getOpenApiArtifactContent = (artifactId: string | number) =>
  readDesktopOpenApi(artifactId).then((result) => result.content);

/** 解析 JSON 或文本响应 */
const parseJsonOrText = async (response: Response) => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * 解析下载响应文件名。
 * @param disposition Content-Disposition 响应头
 * @param fallback 兜底文件名
 * @returns 下载文件名
 */
function parseDownloadFileName(disposition: string | null, fallback: string) {
  const value = disposition || '';
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) return decodeResponseHeader(utf8Match[1]) || fallback;
  const plainMatch = value.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1] || fallback;
}

/**
 * 解码响应头值。
 * @param value 响应头原始值
 * @returns 解码后的值
 */
function decodeResponseHeader(value: string | null) {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 消费 NDJSON 流 */
async function consumeProgressStream<T extends DeployTaskResult = DeployRecord>(response: Response, options: DeployProgressOptions): Promise<T> {
  if (!response.ok) {
    const data = await parseJsonOrText(response);
    const error = new Error(typeof data === 'string' ? data : data?.error || data?.message || '请求失败') as Error & {
      status?: number;
      data?: unknown;
    };
    error.status = response.status;
    error.data = data;
    throw error;
  }

  if (!response.body) {
    const data = await parseJsonOrText(response);
    return data?.data as T;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: T | null = null;

  const consumeLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) return;
    const event = JSON.parse(line) as DeployProgressEvent;
    options.onEvent?.(event);
    if (event.type === 'result') result = event.data as T;
    if (event.type === 'error') throw new Error(event.message || '操作失败');
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      consumeLine(rawLine);
      newlineIndex = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeLine(buffer);
  if (!result) throw new Error('操作未返回结果');
  return result;
}

/** 生成 OpenAPI 并订阅进度 */
export async function generateTargetOpenApiWithProgress(
  targetId: number,
  payload: { branch?: string; force?: boolean; gitlabToken?: string },
  options: DeployProgressOptions = {}
): Promise<OpenApiArtifact> {
  let emittedLogCount = 0;
  return generateOpenApiFromDesktop(targetId, payload, {
    signal: options.signal,
    onOperation(operation) {
      if (operation.progress) {
        options.onEvent?.({ type: 'stage', ...operation.progress, timestamp: new Date().toISOString() });
      }
      for (const log of operation.logs.slice(emittedLogCount)) {
        const level: 'info' | 'success' | 'warn' | 'error' = ['success', 'warn', 'error'].includes(log.level)
          ? log.level as 'success' | 'warn' | 'error'
          : 'info';
        options.onEvent?.({ type: 'log', level, stage: log.stage, message: log.message, timestamp: log.timestamp });
      }
      emittedLogCount = operation.logs.length;
    },
  });
}

/**
 * 执行发布。
 * @param targetId 部署目标 ID
 * @param projectType 项目类型
 * @param payload 发布参数
 * @param options 流式进度配置
 * @returns 发布记录
 */
export async function deployTargetWithProgress(
  targetId: number,
  projectType: DeployTarget['projectType'],
  payload: DeployTargetPublishPayload,
  options: DeployProgressOptions = {}
) {
  if (projectType === 'backend') {
    let emittedLogCount = 0;
    const operation = await deployBackendTargetFromDesktop(targetId, payload.branch, {
      signal: options.signal,
      onOperation(current) {
        if (current.progress) {
          options.onEvent?.({
            type: 'stage',
            stage: current.progress.stage,
            percent: current.progress.percent,
            message: current.progress.message,
            timestamp: new Date().toISOString(),
          });
        }
        for (const log of current.logs.slice(emittedLogCount)) {
          const level: 'info' | 'success' | 'warn' | 'error' = ['success', 'warn', 'error'].includes(log.level)
            ? log.level as 'success' | 'warn' | 'error'
            : 'info';
          options.onEvent?.({ type: 'log', level, stage: log.stage || '', message: log.message, timestamp: log.timestamp });
        }
        emittedLogCount = current.logs.length;
      },
    });
    const result = operation.result as { record?: DeployRecord } | undefined;
    return (result?.record || operation.result) as DeployRecord;
  }
  const response = await fetch(await getTargetExecutionApiUrl(`/targets/${targetId}/deploy?stream=1`, projectType), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', ...getDeployApiAuthHeaders() },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  return consumeProgressStream(response, options);
}

/**
 * 订阅部署目标运行中的发布进度。
 * @param targetId 部署目标 ID
 * @param projectType 项目类型
 * @param options 流式进度配置
 * @returns 发布任务结果
 */
export async function subscribeTargetDeployProgress(
  targetId: number,
  projectType: DeployTarget['projectType'],
  options: DeployProgressOptions = {}
) {
  if (projectType === 'backend') {
    let snapshot = await getTargetDeployProgress(targetId, projectType);
    let lastStageKey = '';
    while (snapshot.running) {
      if (options.signal?.aborted) throw new DOMException('订阅已取消', 'AbortError');
      const stageEvent = snapshot.events.find((event) => event.type === 'stage');
      const stageKey = stageEvent ? `${stageEvent.stage}:${stageEvent.percent}:${stageEvent.message}` : '';
      if (stageEvent && stageKey !== lastStageKey) {
        options.onEvent?.(stageEvent);
        lastStageKey = stageKey;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      const operation = await client.get(`/operations/${snapshot.operationId}`).then(unwrap<CentralDeployOperation>);
      snapshot = mapCentralDeployOperation(operation, targetId);
    }
    if (snapshot.error) throw new Error(snapshot.error);
    if (!snapshot.result) throw new Error('中央部署已结束但未返回发布记录');
    options.onEvent?.({ type: 'result', data: snapshot.result, timestamp: new Date().toISOString() });
    return snapshot.result;
  }
  const response = await fetch(await getTargetExecutionApiUrl(`/targets/${targetId}/deploy-progress?stream=1`, projectType), {
    method: 'GET',
    headers: { Accept: 'application/x-ndjson', ...getDeployApiAuthHeaders() },
    signal: options.signal,
  });
  return consumeProgressStream(response, options);
}

/**
 * 执行回滚。
 * @param recordId 发布记录 ID
 * @param projectType 项目类型
 * @param payload 回滚参数
 * @param options 流式进度配置
 * @returns 回滚后的发布记录
 */
export async function rollbackRecordWithProgress(
  recordId: number,
  projectType: DeployTarget['projectType'],
  payload: { operator?: string },
  options: DeployProgressOptions = {}
) {
  const response = await fetch(await getTargetExecutionApiUrl(`/records/${recordId}/rollback?stream=1`, projectType), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', ...getDeployApiAuthHeaders() },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  return consumeProgressStream(response, options);
}

/**
 * 执行撤销回滚。
 * @param recordId 发布记录 ID
 * @param projectType 项目类型
 * @param payload 撤销回滚参数
 * @param options 流式进度配置
 * @returns 撤销回滚后的发布记录
 */
export async function undoRollbackRecordWithProgress(
  recordId: number,
  projectType: DeployTarget['projectType'],
  payload: { operator?: string },
  options: DeployProgressOptions = {}
) {
  const response = await fetch(await getTargetExecutionApiUrl(`/records/${recordId}/undo-rollback?stream=1`, projectType), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', ...getDeployApiAuthHeaders() },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  return consumeProgressStream(response, options);
}

let activeLocalServerUrl: string | null = null;

/** 本地辅助服务状态。 */
export interface LocalServerStatus {
  port: number;
  pid?: number | null;
  running: boolean;
  status: 'idle' | 'starting' | 'running' | 'error' | string;
  nodePath?: string | null;
  lastError?: string | null;
  lastOutput?: string;
}

/** 本地辅助服务不可用错误。 */
export class LocalServerUnavailableError extends Error {
  /** Tauri 原生侧返回的本地服务状态 */
  status?: LocalServerStatus;

  /**
   * 创建本地服务不可用错误。
   * @param message 错误消息
   * @param status 本地服务状态
   */
  constructor(message: string, status?: LocalServerStatus) {
    super(message);
    this.name = 'LocalServerUnavailableError';
    this.status = status;
  }
}

/** 判断是否为本地辅助服务不可用错误。 */
export const isLocalServerUnavailableError = (error: unknown): error is LocalServerUnavailableError => {
  return error instanceof LocalServerUnavailableError || (error as { name?: string })?.name === 'LocalServerUnavailableError';
};

/**
 * 获取显式配置的本地辅助服务地址。
 * @returns 本地辅助服务基础地址
 */
const getConfiguredLocalServerUrl = () => {
  const configuredUrl = String(import.meta.env.VITE_LOCAL_SERVER_URL || '').trim();
  return configuredUrl.replace(/\/$/, '');
};

/**
 * 动态解析当前客户端本地服务地址。
 * @description Tauri 环境下向 Rust 查询动态端口；浏览器调试环境需显式配置 VITE_LOCAL_SERVER_URL
 */
async function getActiveLocalServerUrl(): Promise<string> {
  if (activeLocalServerUrl) {
    return activeLocalServerUrl;
  }

  // 1. 优先读取显式配置的本地服务地址（如 VITE_LOCAL_SERVER_URL），以便于本地联调与指定端口
  const configuredUrl = getConfiguredLocalServerUrl();
  if (configuredUrl) {
    try {
      await axios.get(`${configuredUrl}/health`, { timeout: 1000 });
      activeLocalServerUrl = configuredUrl;
      console.log(`[Port Detector] 使用 VITE_LOCAL_SERVER_URL 配置的本地辅助服务: ${configuredUrl}`);
      return activeLocalServerUrl;
    } catch (e) {
      console.warn('[Port Detector] VITE_LOCAL_SERVER_URL 配置的本地服务不可用，将尝试自动探测', e);
    }
  }

  const isTauri = typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__ !== undefined;
  let localServerError: LocalServerUnavailableError | null = null;

  // 2. 如果没有有效的手动配置，且在 Tauri 环境中，则自动向 Rust 探测内嵌 Node 端口
  if (isTauri) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const status = await invoke<LocalServerStatus>('get_local_server_status');
      if (status?.running && status.port) {
        const baseUrl = `http://127.0.0.1:${status.port}`;
        await axios.get(`${baseUrl}/health`, { timeout: 1200 });
        activeLocalServerUrl = baseUrl;
        console.log(`[Port Detector] 本地辅助服务健康检查通过: ${baseUrl}`);
        return activeLocalServerUrl;
      }
      const detail = status?.lastError || status?.lastOutput || '本地服务仍在启动或已进入降级模式';
      localServerError = new LocalServerUnavailableError(`本地辅助服务未就绪：${detail}`, status);
    } catch (e) {
      if (isLocalServerUnavailableError(e)) {
        localServerError = e;
      } else {
        localServerError = new LocalServerUnavailableError(
          `本地辅助服务健康检查失败：${e instanceof Error ? e.message : String(e || '未知错误')}`
        );
      }
      console.warn('[Port Detector] 本地辅助服务不可用', e);
    }
  }

  if (localServerError) {
    throw localServerError;
  }
  throw new LocalServerUnavailableError('未找到可用的本地辅助服务地址，请在桌面端内使用，或为浏览器调试配置 VITE_LOCAL_SERVER_URL');
}

/**
 * 获取普通部署业务的中央 API 根地址。
 * @description 不再根据 URL 猜测并回退本地 SQLite；设备能力必须显式调用本机辅助 API。
 * @returns {Promise<string>} 部署 API 根地址
 */
async function getActiveDeployApiBase(): Promise<string> {
  if (!isTauri()) return getApiBase('/deploy-api');
  const session = getCachedSecureAccount();
  if (hasUsableCentralSession(session)) {
    return getApiBase('/deploy-api/v2');
  }
  return getApiBase('/deploy-api');
}

/**
 * 构建当前模式的部署 API 完整地址。
 * @param path 部署 API 内部路径
 * @returns 完整请求地址
 */
async function getActiveDeployApiUrl(path: string): Promise<string> {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const base = await getActiveDeployApiBase();
  return `${base}${normalizedPath}`;
}

/**
 * 按项目类型构建发布任务 API 地址。
 * @description 前端项目始终在中央发布服务器执行；后端项目在桌面端使用本地构建服务。
 * @param path 发布任务 API 路径
 * @param projectType 项目类型
 * @returns 完整请求地址
 */
async function getTargetExecutionApiUrl(path: string, projectType: DeployTarget['projectType']): Promise<string> {
  void projectType;
  return getActiveDeployApiUrl(path);
}

/**
 * 构建本机辅助服务 API 地址。
 * @param path - deploy-api 路径
 * @returns 本机辅助服务完整 URL
 */
async function getLocalDeployApiUrl(path: string): Promise<string> {
  const baseUrl = await getActiveLocalServerUrl();
  return buildLocalDeployApiUrl(baseUrl, path);
}

/**
 * 向内网发布服务器代理接口查询新版本信息
 * @description Token 由内网服务器环境变量 GITHUB_TOKEN 统一管理，前端无需传递
 * @param {string} currentVersion - 当前软件版本号
 * @param {string} platform - 客户端系统类型
 * @param {string} arch - 客户端 CPU 架构
 * @param {string} channel - 更新通道
 */
export type AppUpdateCacheState = 'ready' | 'preparing' | 'missing' | 'failed';

/** 更新包内网缓存状态。 */
export interface AppUpdateCacheStatus {
  status: AppUpdateCacheState;
  progress: number;
  downloadedBytes: number;
  totalBytes: number | null;
  bytesPerSecond: number;
  remainingSeconds: number | null;
  retryCount: number;
  error: string | null;
  etag?: string;
  statusUrl?: string;
  downloadUrl?: string;
}

/** 桌面端更新检测结果。 */
export interface AppUpdateCheckResult {
  hasUpdate: boolean;
  version?: string;
  latestVersion?: string;
  notes?: string;
  updateLogs?: string;
  url?: string;
  downloadUrl?: string;
  filename?: string;
  assetId?: string;
  size?: number;
  sha256?: string;
  signature?: string;
  etag?: string;
  channel?: string;
  target?: string;
  source?: 'manifest' | 'github-release';
  cache?: AppUpdateCacheStatus;
  message?: string;
}

/** 查询桌面端更新信息。 */
export const checkAppUpdateFromServer = (
  currentVersion: string,
  platform: string,
  arch: string,
  channel = 'stable'
): Promise<AppUpdateCheckResult> => {
  return axios.get(getApiBase('/deploy-api/app-update/check'), {
    params: { currentVersion, platform, arch, channel, cacheAware: 1, updaterCapable: 1 },
    headers: getDeployApiAuthHeaders(),
  }).then((res) => {
    const data = res.data as AppUpdateCheckResult;
    if (data && data.downloadUrl && !data.downloadUrl.startsWith('http')) {
      data.downloadUrl = getApiBase(data.downloadUrl);
    }
    if (data && data.url && !data.url.startsWith('http')) {
      data.url = getApiBase(data.url);
    }
    if (data?.cache?.statusUrl && !data.cache.statusUrl.startsWith('http')) {
      data.cache.statusUrl = getApiBase(data.cache.statusUrl);
    }
    return data;
  });
};

/**
 * 查询更新包内网缓存准备状态。
 * @param statusUrl - check 接口返回的缓存状态地址
 * @returns 最新缓存状态
 */
export const getAppUpdateCacheStatus = (statusUrl: string): Promise<AppUpdateCacheStatus> => {
  const url = statusUrl.startsWith('http') ? statusUrl : getApiBase(statusUrl);
  return axios.get(url, {
    headers: getDeployApiAuthHeaders(),
  }).then((res) => {
    const data = res.data as AppUpdateCacheStatus;
    if (data.downloadUrl && !data.downloadUrl.startsWith('http')) {
      data.downloadUrl = getApiBase(data.downloadUrl);
    }
    if (data.statusUrl && !data.statusUrl.startsWith('http')) {
      data.statusUrl = getApiBase(data.statusUrl);
    }
    return data;
  });
};

/** JDK 配置 */
export interface BuildJdk {
  id: number;
  name: string;
  homePath: string;
  javaVersion: string;
  majorVersion: number;
  vendor: string;
  arch: string;
  status: 'unknown' | 'available' | 'unavailable';
  statusOutput: string;
  lastCheckedAt: string;
  remark?: string;
  createdAt: string;
  updatedAt: string;
}

/** JDK 保存参数 */
export interface BuildJdkPayload {
  name: string;
  homePath: string;
  remark?: string;
}

/** 获取 JDK 列表 */
export const listDeployJdks = (): Promise<BuildJdk[]> => {
  return getLocalDeployApiUrl('/jdks').then((url) => axios.get(url).then(unwrap<BuildJdk[]>));
};

/** 新增 JDK 配置 */
export const createDeployJdk = (payload: BuildJdkPayload): Promise<BuildJdk> => {
  return getLocalDeployApiUrl('/jdks').then((url) => axios.post(url, payload).then(unwrap<BuildJdk>));
};

/** 更新 JDK 配置 */
export const updateDeployJdk = (id: number, payload: BuildJdkPayload): Promise<BuildJdk> => {
  return getLocalDeployApiUrl(`/jdks/${id}`).then((url) => axios.put(url, payload).then(unwrap<BuildJdk>));
};

/** 删除 JDK 配置 */
export const deleteDeployJdk = (id: number): Promise<{ deletedJdks: number }> => {
  return getLocalDeployApiUrl(`/jdks/${id}`).then((url) => axios.delete(url).then(unwrap<{ deletedJdks: number }>));
};

/** 检测本机构建 JDK */
export const testDeployJdk = (id: number): Promise<BuildJdk> => {
  return getLocalDeployApiUrl(`/jdks/${id}/test`).then((url) => axios.post(url).then(unwrap<BuildJdk>));
};

/** 扫描并检测本机已安装 JDK */
export const scanLocalDeployJdks = (): Promise<BuildJdk[]> =>
  getLocalDeployApiUrl('/jdks/scan').then((url) => axios.post(url).then(unwrap<BuildJdk[]>));

/** 获取服务器 Java 运行时 */
export const listServerJavaRuntimes = (serverId: number): Promise<ServerJavaRuntime[]> =>
  client.get(`/servers/${serverId}/java-runtimes`).then(unwrap<ServerJavaRuntime[]>);

/** 新增服务器 Java 运行时 */
export const createServerJavaRuntime = (serverId: number, payload: { name: string; homePath: string }): Promise<ServerJavaRuntime> =>
  client.post(`/servers/${serverId}/java-runtimes`, payload).then(unwrap<ServerJavaRuntime>);

/** 扫描服务器 Java 运行时 */
export const scanServerJavaRuntimes = (serverId: number): Promise<ServerJavaRuntime[]> =>
  client.post(`/servers/${serverId}/java-runtimes/scan`).then(unwrap<ServerJavaRuntime[]>);

/** 检测服务器 Java 运行时 */
export const testServerJavaRuntime = (id: number): Promise<ServerJavaRuntime> =>
  client.post(`/java-runtimes/${id}/test`).then(unwrap<ServerJavaRuntime>);

/** 删除服务器 Java 运行时 */
export const deleteServerJavaRuntime = (id: number): Promise<{ deletedRuntimes: number }> =>
  client.delete(`/java-runtimes/${id}`).then(unwrap<{ deletedRuntimes: number }>);

/** 获取共享环境依赖配置 */
export const listDeployEnvironments = (): Promise<DeployEnvironment[]> =>
  client.get('/environments').then(unwrap<DeployEnvironment[]>);

/** 新增共享环境依赖配置 */
export const createDeployEnvironment = (payload: DeployEnvironmentPayload): Promise<DeployEnvironment> =>
  client.post('/environments', payload).then(unwrap<DeployEnvironment>);

/** 更新共享环境依赖配置 */
export const updateDeployEnvironment = (id: number, payload: DeployEnvironmentPayload): Promise<DeployEnvironment> =>
  client.put(`/environments/${id}`, payload).then(unwrap<DeployEnvironment>);

/** 删除共享环境依赖配置 */
export const deleteDeployEnvironment = (id: number): Promise<{ deletedEnvironments: number }> =>
  client.delete(`/environments/${id}`).then(unwrap<{ deletedEnvironments: number }>);
