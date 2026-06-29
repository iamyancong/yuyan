import axios from 'axios';

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

/** Nginx 实例类型 */
export type NginxInstanceType = 'external' | 'managed';

/** 独立服务器配置 */
export interface DeployServer {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: DeployAuthType;
  useSudo: boolean;
  defaultDeployRoot: string;
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
  targetId?: number;
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
}

/** 流式发布事件 */
export type DeployProgressEvent =
  | { type: 'stage'; stage: string; percent: number; message: string; detail?: string; timestamp: string }
  | { type: 'log'; level: DeployLogItem['level']; stage?: string; message: string; timestamp: string }
  | { type: 'result'; data: DeployRecord; timestamp: string }
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
  targetId: number;
  action: 'deploy' | 'rollback' | 'undoRollback';
  operator: string;
  startedAt: string;
  currentStage: string;
  running: boolean;
  result: DeployRecord | null;
  error: string | null;
  events: DeployProgressEvent[];
  maxConcurrent: number;
  runningCount: number;
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

import { getApiBase } from '@/utils/env';

const client = axios.create({ baseURL: getApiBase('/deploy-api') });

/** 提取 API 数据 */
const unwrap = <T>(response: { data: { data: T } }) => response.data.data;

/** 获取服务器列表 */
export const listDeployServers = () => client.get('/servers').then(unwrap<DeployServer[]>);

/** 创建服务器 */
export const createDeployServer = (payload: DeployServerPayload) => client.post('/servers', payload).then(unwrap<DeployServer>);

/** 更新服务器 */
export const updateDeployServer = (id: number, payload: DeployServerPayload) => client.put(`/servers/${id}`, payload).then(unwrap<DeployServer>);

/** 删除服务器 */
export const deleteDeployServer = (id: number) => client.delete(`/servers/${id}`);

/** 测试服务器连接 */
export const testDeployServer = (id: number) => client.post(`/servers/${id}/test`).then(unwrap<{ success: boolean; output: string }>);

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
  const response = await fetch(getApiBase(`/deploy-api/servers/${serverId}/nginx-runtime/init?stream=1`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
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
  const response = await fetch(getApiBase(`/deploy-api/nginx-instances/${instanceId}/init?stream=1`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
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
 * 下载托管 Nginx 实例运行包。
 * @param instanceId Nginx 实例 ID
 * @returns 运行包 Blob 与响应元信息
 */
export async function downloadNginxInstanceArchive(instanceId: number): Promise<NginxInstanceArchiveDownload> {
  const response = await fetch(getApiBase(`/deploy-api/nginx-instances/${instanceId}/archive`), { credentials: 'include' });
  if (!response.ok) {
    const data = await parseJsonOrText(response);
    throw new Error(typeof data === 'string' ? data : data?.error || data?.message || '下载运行包失败');
  }
  return {
    blob: await response.blob(),
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
export const deleteDeployTarget = (id: number) => client.delete(`/targets/${id}`);

/** 获取发布记录列表 */
export const listDeployRecords = (params?: DeployRecordQuery, gitlabToken = '', gitlabHost = '') =>
  client
    .get('/records', { params, headers: gitlabToken ? { 'X-GitLab-Token': gitlabToken, 'X-GitLab-Host': gitlabHost } : undefined })
    .then(unwrap<DeployRecordPage>);

/** 获取发布记录详情 */
export const getDeployRecord = (recordId: number, gitlabToken = '', gitlabHost = '') =>
  client.get(`/records/${recordId}`, { headers: gitlabToken ? { 'X-GitLab-Token': gitlabToken, 'X-GitLab-Host': gitlabHost } : undefined }).then(unwrap<DeployRecord>);

/** 读取 Nginx 配置文件 */
export const readNginxConf = (targetId: number) => client.get(`/targets/${targetId}/nginx-conf`).then(unwrap<{ path: string; content: string }>);

/** 保存 Nginx 配置文件 */
export const saveNginxConf = (targetId: number, content: string, reload = true) =>
  client.put(`/targets/${targetId}/nginx-conf`, { content, reload }).then(unwrap<{ backupPath: string; testOutput: string }>);

/** 测试 Nginx 配置文件 */
export const testNginxConf = (targetId: number) => client.post(`/targets/${targetId}/nginx-test`).then(unwrap<{ output: string }>);

/** 同步托管 Nginx 站点配置 */
export const syncNginxSite = (targetId: number) => client.post(`/targets/${targetId}/nginx-site/sync`).then(unwrap<NginxSiteSyncResult>);

/** 获取部署目标运行中的发布进度快照 */
export const getTargetDeployProgress = (targetId: number) => client.get(`/targets/${targetId}/deploy-progress`).then(unwrap<DeployProgressSnapshot>);

/** 停止部署目标运行中的发布任务 */
export const stopTargetDeploy = (targetId: number) => client.post(`/targets/${targetId}/deploy/stop`).then(unwrap<DeployProgressSnapshot>);

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
async function consumeProgressStream(response: Response, options: DeployProgressOptions) {
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
    return data?.data as DeployRecord;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: DeployRecord | null = null;

  const consumeLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) return;
    const event = JSON.parse(line) as DeployProgressEvent;
    options.onEvent?.(event);
    if (event.type === 'result') result = event.data;
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

/** 执行发布 */
export async function deployTargetWithProgress(targetId: number, payload: DeployTargetPublishPayload, options: DeployProgressOptions = {}) {
  const response = await fetch(getApiBase(`/deploy-api/targets/${targetId}/deploy?stream=1`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  return consumeProgressStream(response, options);
}

/** 订阅部署目标运行中的发布进度 */
export async function subscribeTargetDeployProgress(targetId: number, options: DeployProgressOptions = {}) {
  const response = await fetch(getApiBase(`/deploy-api/targets/${targetId}/deploy-progress?stream=1`), {
    method: 'GET',
    headers: { Accept: 'application/x-ndjson' },
    signal: options.signal,
  });
  return consumeProgressStream(response, options);
}

/** 执行回滚 */
export async function rollbackRecordWithProgress(recordId: number, payload: { operator?: string }, options: DeployProgressOptions = {}) {
  const response = await fetch(getApiBase(`/deploy-api/records/${recordId}/rollback?stream=1`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  return consumeProgressStream(response, options);
}

/** 执行撤销回滚 */
export async function undoRollbackRecordWithProgress(recordId: number, payload: { operator?: string }, options: DeployProgressOptions = {}) {
  const response = await fetch(getApiBase(`/deploy-api/records/${recordId}/undo-rollback?stream=1`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  return consumeProgressStream(response, options);
}

/**
 * 备份/下载指定服务器的数据库文件 (ArrayBuffer)
 * @param {string} serverUrl - 目标服务器基础地址
 * @returns {Promise<ArrayBuffer>} 数据库二进制数据
 */
export const backupDbFromServer = (serverUrl: string): Promise<ArrayBuffer> => {
  const normalizedUrl = serverUrl.replace(/\/$/, '') + '/deploy-api/db/backup';
  return axios.get(normalizedUrl, { responseType: 'arraybuffer' }).then((res) => res.data);
};

let activeLocalPort: number | null = null;

/**
 * 动态检测并嗅探当前客户端本地服务监听的端口 (3101 或 3100)
 * @description 兼容新版 (3101) 和旧版 (3100) 客户端外壳，避免由于版本不一致导致更新和同步功能失效
 */
const getActiveLocalPort = async (): Promise<number> => {
  if (activeLocalPort !== null) {
    return activeLocalPort;
  }
  
  // 1. 优先尝试请求 3101（新端口）
  try {
    await axios.get('http://localhost:3101/deploy-api/app-update/status', { timeout: 1000 });
    activeLocalPort = 3101;
    console.log('[Port Detector] 探测到本地辅助服务运行在 3101 端口');
    return 3101;
  } catch (e) {
    // 2. 3101 不通，尝试 3100（旧端口）
    try {
      await axios.get('http://localhost:3100/deploy-api/app-update/status', { timeout: 1000 });
      activeLocalPort = 3100;
      console.log('[Port Detector] 探测到本地辅助服务运行在 3100 端口 (旧版本客户端)');
      return 3100;
    } catch (e2) {
      // 3. 两个都不通，默认为 3101，后续发起具体请求时会触发错误
      console.warn('[Port Detector] 未探测到本地辅助服务端口，默认使用 3101');
      return 3101;
    }
  }
};

/**
 * 还原二进制数据库数据到本地服务
 * @param {ArrayBuffer} data - 数据库二进制数据
 * @returns {Promise<{ success: boolean; message: string }>} 操作结果
 */
export const restoreDbToLocal = async (data: ArrayBuffer): Promise<{ success: boolean; message: string }> => {
  const port = await getActiveLocalPort();
  return axios.post(`http://localhost:${port}/deploy-api/db/restore`, data, {
    headers: {
      'Content-Type': 'application/octet-stream',
    },
  }).then((res) => res.data);
};

/**
 * 向内网发布服务器代理接口查询新版本信息
 * @description Token 由内网服务器环境变量 GITHUB_TOKEN 统一管理，前端无需传递
 * @param {string} currentVersion - 当前软件版本号
 * @param {string} platform - 客户端系统类型
 * @param {string} arch - 客户端 CPU 架构
 * @param {string} channel - 更新通道
 */
export interface AppUpdateCheckResult {
  hasUpdate: boolean;
  version?: string;
  latestVersion?: string;
  notes?: string;
  updateLogs?: string;
  url?: string;
  downloadUrl?: string;
  filename?: string;
  size?: number;
  sha256?: string;
  signature?: string;
  etag?: string;
  channel?: string;
  target?: string;
  source?: 'manifest' | 'github-release';
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
    params: { currentVersion, platform, arch, channel }
  }).then((res) => {
    const data = res.data as AppUpdateCheckResult;
    if (data && data.downloadUrl && !data.downloadUrl.startsWith('http')) {
      data.downloadUrl = getApiBase(data.downloadUrl);
    }
    if (data && data.url && !data.url.startsWith('http')) {
      data.url = getApiBase(data.url);
    }
    return data;
  });
};
