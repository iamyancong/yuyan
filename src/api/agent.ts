import { invoke } from '@tauri-apps/api/core';
import { getGitLabHost, getGitLabToken } from '@/api/gitlab';
import { getCachedSecureAccount } from '@/services/secureAuth';
import { getCentralAccountApprovalPolicy } from '@/api/centralIdentity';
import { getApiBase, isTauri } from '@/utils/env';
import { createSseFrameParser } from './agentStream';

/** Agent 操作状态。 */
export type AgentOperationStatus = 'pending_approval' | 'queued' | 'running' | 'succeeded' | 'failed' | 'rejected' | 'cancelled' | 'expired';

/** Agent 运行时描述。 */
export interface AgentRuntimeDescriptor {
  schemaVersion: 1;
  appVersion: string;
  pid: number;
  port: number;
  sessionToken: string;
  startedAt: string;
}

/** Tauri 返回的 Agent 运行时状态。 */
export interface AgentRuntimeStatus {
  descriptor: AgentRuntimeDescriptor;
  executablePath: string;
}

/** Agent 异步操作。 */
export interface AgentOperation {
  id: string;
  toolName: string;
  client: 'codex' | 'cursor' | 'antigravity' | 'generic';
  workspacePath?: string;
  riskLevel: 'read' | 'config_write' | 'external_effect' | 'destructive';
  payloadHash: string;
  executionScope: 'server' | 'local';
  status: AgentOperationStatus;
  progress?: { stage: string; percent: number; message: string };
  actor?: AgentExecutionContext;
  result?: Record<string, unknown> & { executionReport?: AgentExecutionReport };
  error?: { code: string; message: string; retryable: boolean };
  logs: Array<{ timestamp: string; level: string; stage?: string; message: string }>;
  approvalSummary?: Record<string, unknown>;
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
}

/** 全局审批弹窗使用的轻量任务投影。 */
export interface AgentPendingApproval {
  id: string;
  toolName: string;
  client: AgentOperation['client'];
  riskLevel: AgentOperation['riskLevel'];
  payloadHash: string;
  executionScope: AgentOperation['executionScope'];
  approvalSummary?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Agent SSE 变更域。 */
export type AgentChangeDomain = 'approvals' | 'operations' | 'grants' | 'audit' | 'policy';

/** Agent SSE 事件。 */
export interface AgentStreamEvent {
  revision: number;
  domains: AgentChangeDomain[];
}

/** Agent 操作的真实账号、设备、隔离空间与客户端。 */
export interface AgentExecutionContext {
  accountId: string;
  deviceId: string;
  teamId: string;
  client: 'codex' | 'cursor' | 'antigravity' | 'generic';
}

/** 仅在操作成功后返回的统一执行回执。 */
export interface AgentExecutionReport {
  summary: string;
  action: string;
  executionScope: 'device' | 'central';
  actor: AgentExecutionContext;
  object: { type: string; id: string | number; name?: string };
  changes: string[];
  verification: string[];
  completedAt: string;
}

/** Agent 审批策略。 */
export interface AgentApprovalPolicy {
  autoApproveGrantedProjects: boolean;
}

/** 已结束 Agent 任务的本机保留策略，0 表示永久保留。 */
export interface AgentOperationRetentionPolicy {
  retentionDays: 0 | 7 | 30 | 90;
}

/** 稳定 MCP 启动器信息。 */
export interface AgentLauncherInfo {
  path: string;
  runtimeMode: 'development' | 'installed';
  stable: boolean;
  sameMachineOnly: boolean;
}

/** 项目授权。 */
export interface AgentProjectGrant {
  id: string;
  client: string;
  workspacePath: string;
  remoteUrl: string;
  permissions: string[];
  updatedAt: string;
}

/** 客户端安装状态。 */
export interface AgentClientStatus {
  client: 'codex' | 'cursor' | 'antigravity';
  label: string;
  configPath: string;
  installed: boolean;
  needsRepair: boolean;
}

/** AI 控制平面快照。 */
export interface AgentSnapshot {
  approvalPolicy: AgentApprovalPolicy;
  operationRetentionPolicy: AgentOperationRetentionPolicy;
  operations: { items: AgentOperation[]; total: number; completedTotal: number };
  grants: { items: AgentProjectGrant[]; total: number };
  audit: { items: Array<Record<string, unknown>>; total: number };
  auditChain: { valid: boolean; count: number; brokenAt?: string };
}

let runtimeCache: AgentRuntimeStatus | null = null;

/** 使 Agent Runtime 缓存失效，供本机服务重启后重新发现端口与令牌。 */
export function invalidateAgentRuntimeCache(): void {
  runtimeCache = null;
}

/** 获取并缓存本次启动的 Agent Gateway 运行时信息。 */
export async function getAgentRuntime(): Promise<AgentRuntimeStatus> {
  if (!isTauri()) throw new Error('AI 集成仅在雨燕桌面端可用');
  if (!runtimeCache) runtimeCache = await invoke<AgentRuntimeStatus>('get_agent_runtime');
  return runtimeCache;
}

/** 调用本机 Agent Gateway。 */
async function requestAgentApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const runtime = await getAgentRuntime();
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${runtime.descriptor.port}/agent-api/v1${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${runtime.descriptor.sessionToken}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    invalidateAgentRuntimeCache();
    throw error;
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    if (response.status === 401) invalidateAgentRuntimeCache();
    const error = new Error(body?.error?.message || `Agent Gateway 返回 HTTP ${response.status}`) as Error & {
      code?: string; status?: number; response?: { status: number };
    };
    error.code = body?.error?.code;
    error.status = response.status;
    error.response = { status: response.status };
    throw error;
  }
  return body.data as T;
}

/** 将 WebView 当前中央 API 与已有凭据同步到内嵌服务内存。 */
export async function syncAgentRuntimeSettings(): Promise<void> {
  const centralApiBase = getApiBase('');
  const secure = getCachedSecureAccount();
  let forcedApprovalTools: string[] = [];
  let accountApprovalPolicyReady = false;
  if (secure?.accessToken && secure.teamId && Date.parse(secure.accessExpiresAt) > Date.now()) {
    try {
      forcedApprovalTools = (await getCentralAccountApprovalPolicy(secure)).forcedTools;
      accountApprovalPolicyReady = true;
    } catch {
      /** 账号审批策略不可验证时保持失败关闭，所有写操作转为人工审批。 */
    }
  }
  await requestAgentApi('/settings', {
    method: 'POST',
    body: JSON.stringify({
      centralApiBase,
      centralAccessToken: secure?.accessToken || '',
      centralAccessExpiresAt: secure?.accessExpiresAt || '',
      gitlabHost: getGitLabHost(),
      gitlabToken: getGitLabToken(),
      accountId: secure?.accountId || '',
      deviceId: secure?.deviceId || '',
      teamId: secure?.teamId || '',
      role: secure?.role || '',
      forcedApprovalTools,
      accountApprovalPolicyReady,
    }),
  });
}

/** 获取 AI 控制平面快照。 */
export const getAgentSnapshot = () => requestAgentApi<AgentSnapshot>('/snapshot');

/** 获取全局审批弹窗所需的轻量待审批任务。 */
export const getPendingAgentApprovals = () => requestAgentApi<{ items: AgentPendingApproval[]; total: number }>('/pending-approvals');

/**
 * 订阅本机 Agent Gateway 变更事件。
 * @param options 中断信号与事件回调
 */
export async function subscribeAgentEvents(options: {
  signal: AbortSignal;
  onEvent: (event: AgentStreamEvent, eventName: 'ready' | 'change') => void;
}): Promise<void> {
  const runtime = await getAgentRuntime();
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${runtime.descriptor.port}/agent-api/v1/events`, {
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${runtime.descriptor.sessionToken}`,
      },
      signal: options.signal,
    });
  } catch (error) {
    invalidateAgentRuntimeCache();
    throw error;
  }
  if (!response.ok) {
    if (response.status === 401) invalidateAgentRuntimeCache();
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message || `Agent Gateway SSE 返回 HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Agent Gateway SSE 响应不支持流式读取');
  const decoder = new TextDecoder();
  const parser = createSseFrameParser((frame) => {
    if (frame.event !== 'ready' && frame.event !== 'change') return;
    try {
      const event = JSON.parse(frame.data) as AgentStreamEvent;
      if (!Number.isFinite(event.revision) || !Array.isArray(event.domains)) return;
      options.onEvent(event, frame.event);
    } catch {
      /** 单个异常事件不应断开后续正常 SSE。 */
    }
  });
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push(decoder.decode());
  parser.finish();
  if (!options.signal.aborted) throw new Error('Agent Gateway SSE 连接已结束');
}

/** 获取客户端安装状态和标准配置。 */
export const getAgentClients = () => requestAgentApi<{ clients: AgentClientStatus[]; genericConfig: Record<string, unknown> | null; launcher: AgentLauncherInfo | null }>('/clients');

/** 更新已授权项目的自动执行策略。 */
export const updateAgentApprovalPolicy = (autoApproveGrantedProjects: boolean) => requestAgentApi<AgentApprovalPolicy>('/approval-policy', {
  method: 'PUT',
  body: JSON.stringify({ autoApproveGrantedProjects, changedBy: '雨燕桌面端用户' }),
});

/** 安装或修复 MCP 客户端。 */
export const installAgentClient = (client: AgentClientStatus['client']) => requestAgentApi(`/clients/${client}/install`, { method: 'POST' });

/** 卸载 MCP 客户端。 */
export const uninstallAgentClient = (client: AgentClientStatus['client']) => requestAgentApi(`/clients/${client}/uninstall`, { method: 'POST' });

/** 批准 Agent 操作。 */
export const approveAgentOperation = (id: string) => requestAgentApi<AgentOperation>(`/operations/${id}/approve`, { method: 'POST', body: JSON.stringify({ approvedBy: '雨燕桌面端用户' }) });

/** 拒绝 Agent 操作。 */
export const rejectAgentOperation = (id: string) => requestAgentApi<AgentOperation>(`/operations/${id}/reject`, { method: 'POST', body: JSON.stringify({ approvedBy: '雨燕桌面端用户' }) });

/** 取消 Agent 操作。 */
export const cancelAgentOperation = (id: string) => requestAgentApi<AgentOperation>(`/operations/${id}/cancel`, { method: 'POST' });

/** 删除一条已结束 Agent 任务记录。 */
export const deleteAgentOperation = (id: string) => requestAgentApi<{ deleted: boolean }>(`/operations/${id}`, {
  method: 'DELETE',
  body: JSON.stringify({ changedBy: '雨燕桌面端用户' }),
});

/** 清空当前账号和设备的全部已结束 Agent 任务。 */
export const clearCompletedAgentOperations = () => requestAgentApi<{ deletedCount: number }>('/operations/completed', {
  method: 'DELETE',
  body: JSON.stringify({ changedBy: '雨燕桌面端用户' }),
});

/** 更新已结束 Agent 任务的本机保留策略。 */
export const updateAgentOperationRetentionPolicy = (retentionDays: AgentOperationRetentionPolicy['retentionDays']) => requestAgentApi<AgentOperationRetentionPolicy & { deletedCount: number }>('/operation-retention-policy', {
  method: 'PUT',
  body: JSON.stringify({ retentionDays, changedBy: '雨燕桌面端用户' }),
});

/** 查询单个 Agent 任务。 */
export const getAgentOperation = (id: string) => requestAgentApi<AgentOperation>(`/operations/${id}`);

/**
 * 从雨燕桌面部署页启动后端设备构建，并轮询到中央部署终态。
 * @param targetId 中央部署目标 ID
 * @param branch 发布分支
 * @param options 取消信号与任务快照回调
 */
export async function deployBackendTargetFromDesktop(
  targetId: number,
  branch: string,
  options: { signal?: AbortSignal; onOperation?: (operation: AgentOperation) => void } = {},
): Promise<AgentOperation> {
  await syncAgentRuntimeSettings();
  let operation = await requestAgentApi<AgentOperation>('/desktop/backend-deploy', {
    method: 'POST',
    body: JSON.stringify({ targetId, branch, idempotencyKey: `desktop-${crypto.randomUUID()}` }),
  });
  options.onOperation?.(operation);
  while (!['succeeded', 'failed', 'cancelled', 'expired', 'rejected'].includes(operation.status)) {
    if (options.signal?.aborted) {
      await cancelAgentOperation(operation.id).catch(() => undefined);
      throw new DOMException('发布任务已取消', 'AbortError');
    }
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    operation = await getAgentOperation(operation.id);
    options.onOperation?.(operation);
  }
  if (operation.status !== 'succeeded') throw new Error(operation.error?.message || `后端发布状态：${operation.status}`);
  return operation;
}

/** 当前设备生成的 OpenAPI 元数据。 */
export interface DeviceOpenApiArtifact {
  id: string;
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

/** 从雨燕桌面端生成 OpenAPI 并轮询到终态。 */
export async function generateOpenApiFromDesktop(
  targetId: number,
  payload: { branch?: string; force?: boolean },
  options: { signal?: AbortSignal; onOperation?: (operation: AgentOperation) => void } = {},
): Promise<DeviceOpenApiArtifact> {
  await syncAgentRuntimeSettings();
  let operation = await requestAgentApi<AgentOperation>('/desktop/openapi/generate', {
    method: 'POST',
    body: JSON.stringify({ targetId, branch: payload.branch, force: payload.force, idempotencyKey: `desktop-openapi-${crypto.randomUUID()}` }),
  });
  options.onOperation?.(operation);
  while (!['succeeded', 'failed', 'cancelled', 'expired', 'rejected'].includes(operation.status)) {
    if (options.signal?.aborted) {
      await cancelAgentOperation(operation.id).catch(() => undefined);
      throw new DOMException('OpenAPI 生成已取消', 'AbortError');
    }
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    operation = await getAgentOperation(operation.id);
    options.onOperation?.(operation);
  }
  if (operation.status !== 'succeeded') throw new Error(operation.error?.message || `OpenAPI 生成状态：${operation.status}`);
  return operation.result as unknown as DeviceOpenApiArtifact;
}

/** 获取当前设备指定目标最新 OpenAPI。 */
export function getLatestDesktopOpenApi(targetId: number, branch = '') {
  const query = new URLSearchParams({ targetId: String(targetId), ...(branch ? { branch } : {}) });
  return requestAgentApi<DeviceOpenApiArtifact>(`/desktop/openapi/latest?${query}`);
}

/** 读取当前设备 OpenAPI 内容。 */
export function readDesktopOpenApi(id: string | number) {
  return requestAgentApi<{ artifact: DeviceOpenApiArtifact; content: string }>(`/desktop/openapi/${encodeURIComponent(String(id))}`);
}

/** 撤销项目授权。 */
export const revokeAgentGrant = (id: string) => requestAgentApi<{ revoked: boolean }>(`/grants/${id}`, { method: 'DELETE' });
