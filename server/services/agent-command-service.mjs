/**
 * Agent 工具命令与异步执行服务。
 * @description MCP、HTTP 页面与雨燕 UI 共享同一受控命令入口。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { DEPLOY_OPENAPI_DIR, PORT } from '../config/constants.mjs';
import {
  appendAgentAudit,
  clearCompletedAgentOperationRecords,
  createAgentOperation,
  createAgentPlan,
  deleteAgentOperationRecord,
  getAgentApprovalPolicy,
  getAgentOperationRetentionPolicy,
  getAgentOperation,
  getAgentOperationInternal,
  getAgentOperationPayload,
  getAgentOperationPayloadInternal,
  getDeviceOpenApiArtifact,
  getLatestDeviceOpenApiArtifact,
  getAgentPlan,
  listAgentAudit,
  listAgentOperations,
  listProjectGrants,
  revokeProjectGrant,
  saveDeviceOpenApiArtifact,
  updateAgentApprovalPolicy,
  updateAgentOperationRetentionPolicy,
  updateAgentOperation,
  updateAgentOperationInternal,
  upsertProjectGrant,
  verifyAgentAuditChain,
} from './agent-store.mjs';
import { hashAgentPayload, redactAgentText, redactAgentValue } from './agent-security.mjs';
import { AgentError, inspectAgentWorkspace, normalizeRepositoryUrl, requireProjectGrant } from './agent-workspace-service.mjs';
import { getAgentRuntimeSettings } from './agent-runtime-service.mjs';
import { buildBackendArtifactOnDevice } from './backend-runtime-service.mjs';
import { generateOpenApiFromTargetConfig } from './backend-project-service.mjs';

const VALID_CLIENTS = new Set(['codex', 'cursor', 'antigravity', 'generic']);
const VALID_OPERATION_STATUSES = new Set(['pending_approval', 'queued', 'running', 'succeeded', 'failed', 'rejected', 'cancelled', 'expired']);
const OPERATOR_TOOL_NAMES = new Set([
  'yuyan_apply_project_config',
  'yuyan_create_microapp',
  'yuyan_deploy_target',
  'yuyan_rollback_deployment',
  'yuyan_control_service',
  'yuyan_generate_openapi',
]);
const activeOperationControllers = new Map();

/** 解析游标偏移。 */
function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const value = Number(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** 创建下一页游标。 */
const encodeCursor = (offset) => Buffer.from(String(offset)).toString('base64url');

/** 规范化客户端标识。 */
export function normalizeAgentClient(value) {
  const client = String(value || 'generic').toLowerCase();
  return VALID_CLIENTS.has(client) ? client : 'generic';
}

/** 创建 Agent 错误公共结构。 */
export function serializeAgentError(error) {
  const source = error instanceof Error ? error : new Error(String(error || '未知错误'));
  return {
    code: source.code || 'agent_operation_failed',
    message: redactAgentText(source.message || '操作失败'),
    retryable: Boolean(source.retryable),
    ...(source.details ? { details: redactAgentValue(source.details) } : {}),
  };
}

/** 获取中央或本地 API 根地址。 */
function resolveApiContext(requestedScope = 'server') {
  const settings = getAgentRuntimeSettings({ includeSecrets: true });
  if (requestedScope === 'local') {
    return { baseUrl: `http://127.0.0.1:${PORT}`, executionScope: 'local', routePrefix: '/deploy-api', settings };
  }
  if (settings.centralApiBase) {
    if (!settings.centralSessionReady || !settings.centralAccessToken) {
      throw new AgentError('central_session_required', '中央会话未就绪，请在雨燕重新登录', { retryable: true });
    }
    return { baseUrl: settings.centralApiBase, executionScope: 'server', routePrefix: '/deploy-api/v2', settings };
  }
  throw new AgentError('central_unavailable', '尚未配置中央服务；离线模式仅允许项目识别和本地只读诊断', { retryable: true });
}

/** 调用现有雨燕领域 HTTP 接口。 */
async function callYuyanApi(route, options = {}) {
  const context = resolveApiContext(options.scope || 'server');
  const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) };
  let resolvedRoute = route;
  if (context.executionScope === 'server') {
    headers.Authorization = `Bearer ${context.settings.centralAccessToken}`;
    headers['X-Yuyan-Team-Id'] = context.settings.teamId;
    headers['X-Yuyan-Client'] = String(options.client || 'mcp');
    headers['X-GitLab-Token'] = context.settings.gitlabToken;
    headers['X-GitLab-Host'] = context.settings.gitlabHost;
    resolvedRoute = route.replace(/^\/deploy-api(?=\/|$)/, context.routePrefix);
  }
  let response;
  try {
    response = await fetch(`${context.baseUrl}${resolvedRoute}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
    });
  } catch (error) {
    throw new AgentError('central_unavailable', `中央服务当前不可用：${redactAgentText(error?.message || '网络连接失败')}`, { retryable: true });
  }
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json().catch(() => null) : await response.text();
  if (!response.ok) {
    const message = typeof body === 'string' ? body : body?.error?.message || body?.error || body?.message || `雨燕接口返回 HTTP ${response.status}`;
    const code = response.status === 401 ? 'central_session_required' : response.status === 403 ? 'forbidden_role' : 'yuyan_api_error';
    throw new AgentError(code, redactAgentText(message), {
      retryable: response.status >= 500,
    });
  }
  return { data: body?.data ?? body, executionScope: context.executionScope };
}

/** 上传一个中央产物分块。 */
async function uploadCentralArtifactChunk(jobId, chunk, start, total, signal) {
  const context = resolveApiContext('server');
  const end = start + chunk.byteLength - 1;
  let response;
  try {
    response = await fetch(`${context.baseUrl}${context.routePrefix}/artifact-jobs/${encodeURIComponent(jobId)}/chunks`, {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${context.settings.centralAccessToken}`,
        'X-Yuyan-Team-Id': context.settings.teamId,
        'X-Yuyan-Client': 'mcp',
        'X-GitLab-Token': context.settings.gitlabToken,
        'X-GitLab-Host': context.settings.gitlabHost,
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end}/${total}`,
      },
      body: chunk,
      signal,
    });
  } catch (error) {
    throw new AgentError('central_unavailable', `中央产物上传失败：${redactAgentText(error?.message || '网络连接失败')}`, { retryable: true });
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    const error = new AgentError(body?.error?.code || 'artifact_upload_failed', body?.error?.message || `中央产物上传返回 HTTP ${response.status}`, { retryable: response.status >= 500 });
    if (Number.isSafeInteger(body?.error?.expectedOffset)) error.details = { expectedOffset: body.error.expectedOffset };
    throw error;
  }
  return body.data;
}

/** 支持取消地等待一小段时间。 */
function waitWithSignal(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('任务已取消'), { code: 'cancelled' }));
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('任务已取消'), { code: 'cancelled' }));
    }, { once: true });
  });
}

/** 在设备构建 Jar、断点分块上传并等待中央部署完成。 */
async function deployBackendViaCentral(operation, payload, target, settings, signal) {
  const isolatedTarget = {
    ...target,
    id: `${hashAgentPayload({ accountId: operation.actor.accountId, teamId: operation.actor.teamId }).slice(0, 16)}-${target.id}`,
  };
  const artifact = await buildBackendArtifactOnDevice(isolatedTarget, {
    branch: payload.branch,
    gitlabToken: settings.gitlabToken,
    signal,
  }, {
    stage: (stage, percent, message) => updateOperationProgress(operation.id, stage, Math.min(48, percent), message),
    log: (level, message, stage) => appendOperationLog(operation.id, level, message, stage),
  });
  if (payload.commitSha && artifact.commitSha !== payload.commitSha) {
    throw new AgentError('commit_changed', `设备构建的 Commit ${artifact.commitSha} 与审批绑定 Commit ${payload.commitSha} 不一致`);
  }
  updateOperationProgress(operation.id, 'artifact_job', 50, '正在中央创建受控产物任务');
  const job = (await callYuyanApi('/deploy-api/artifact-jobs', {
    scope: 'server',
    method: 'POST',
    body: {
      targetId: Number(target.id),
      fileName: artifact.artifactName,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.artifactSha256,
      commitSha: artifact.commitSha,
      commitMessage: artifact.commitMessage,
      commitAuthor: artifact.commitAuthor,
      branch: artifact.branch,
      idempotencyKey: `mcp-${operation.id}`,
    },
    signal,
  })).data;
  updateAgentOperationInternal(operation.id, {
    result: { centralOperationId: job.operationId, artifactJobId: job.id },
  });
  const handle = await fs.open(artifact.artifactPath, 'r');
  try {
    const chunkSize = 4 * 1024 * 1024;
    let offset = Math.max(0, Number(job.uploadedSize || 0));
    while (offset < artifact.sizeBytes) {
      if (signal.aborted) throw Object.assign(new Error('任务已取消'), { code: 'cancelled' });
      const length = Math.min(chunkSize, artifact.sizeBytes - offset);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (!bytesRead) throw new AgentError('artifact_read_failed', '读取设备 Jar 产物时意外结束');
      const uploaded = await uploadCentralArtifactChunk(job.id, buffer.subarray(0, bytesRead), offset, artifact.sizeBytes, signal);
      offset = Number(uploaded.uploadedSize || offset + bytesRead);
      updateOperationProgress(operation.id, 'upload', 50 + Math.round((offset / artifact.sizeBytes) * 25), `正在上传构建产物 ${offset}/${artifact.sizeBytes}`);
    }
  } finally {
    await handle.close();
  }
  updateOperationProgress(operation.id, 'verify', 76, '中央正在校验产物哈希');
  let centralOperation = (await callYuyanApi(`/deploy-api/artifact-jobs/${job.id}/finalize`, {
    scope: 'server', method: 'POST', body: {}, signal,
  })).data;
  const deadline = Date.now() + 45 * 60_000;
  while (!['succeeded', 'failed', 'cancelled', 'expired'].includes(centralOperation.status)) {
    if (Date.now() >= deadline) throw new AgentError('central_operation_timeout', '中央部署超过 45 分钟，可稍后通过任务 ID 查询', { retryable: true });
    updateOperationProgress(operation.id, centralOperation.result?.progress?.stage || 'central_deploy', Math.max(78, Math.min(98, Number(centralOperation.result?.progress?.percent || 0))), centralOperation.result?.progress?.message || '中央正在部署并执行健康检查');
    await waitWithSignal(1_000, signal);
    centralOperation = (await callYuyanApi(`/deploy-api/operations/${centralOperation.id}`, { scope: 'server', signal })).data;
  }
  if (centralOperation.status !== 'succeeded') {
    throw new AgentError(centralOperation.error?.code || 'central_deploy_failed', centralOperation.error?.message || `中央部署状态：${centralOperation.status}`, { retryable: Boolean(centralOperation.error?.retryable) });
  }
  return centralOperation.result;
}

/** 从列表参数生成统一游标分页结果。 */
function paginateItems(items, args = {}) {
  const limit = Math.min(100, Math.max(1, Number(args.limit || 20)));
  const offset = decodeCursor(args.cursor);
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  return {
    items: page,
    total: items.length,
    nextCursor: nextOffset < items.length ? encodeCursor(nextOffset) : null,
  };
}

/** 获取中央配置目标详情。 */
async function getConfiguredTarget(targetId) {
  const { data, executionScope } = await callYuyanApi('/deploy-api/targets', { scope: 'server' });
  const target = (Array.isArray(data) ? data : []).find((item) => Number(item.id) === Number(targetId));
  if (!target) throw new AgentError('target_not_found', '部署目标不存在');
  return { target, configScope: executionScope };
}

/** 获取中央配置服务器详情。 */
async function getConfiguredServer(serverId) {
  const { data, executionScope } = await callYuyanApi('/deploy-api/servers', { scope: 'server' });
  const server = (Array.isArray(data) ? data : []).find((item) => Number(item.id) === Number(serverId));
  if (!server) throw new AgentError('server_not_found', '部署服务器不存在');
  return { server, configScope: executionScope };
}

/** 校验部署目标确实属于当前授权工作区。 */
function requireTargetWorkspaceMatch(target, workspace) {
  const targetRepository = normalizeRepositoryUrl(target?.repositoryUrl || '');
  const workspaceRepository = normalizeRepositoryUrl(workspace?.remoteUrl || '');
  const repositoryMatched = targetRepository && workspaceRepository && targetRepository === workspaceRepository;
  const fallbackMatched = !targetRepository && (
    String(target?.projectPath || '') === String(workspace?.projectName || '')
    || String(target?.projectName || '') === String(workspace?.projectName || '')
  );
  if (!repositoryMatched && !fallbackMatched) {
    throw new AgentError('target_workspace_mismatch', '部署目标不属于当前已授权项目，雨燕已阻止跨项目操作');
  }
  return target;
}

/** 生成部署目标稳定身份摘要。 */
const getTargetIdentityHash = (target) => hashAgentPayload({
  id: Number(target?.id || 0),
  projectName: String(target?.projectName || ''),
  repositoryUrl: normalizeRepositoryUrl(target?.repositoryUrl || ''),
  serverId: Number(target?.serverId || 0),
});

/** 生成部署服务器稳定身份摘要。 */
const getServerIdentityHash = (server) => hashAgentPayload({
  id: Number(server?.id || 0),
  name: String(server?.name || ''),
  host: String(server?.host || ''),
  port: Number(server?.port || 22),
});

/** 向操作追加受限阶段日志。 */
function appendOperationLog(operationId, level, message, stage = '') {
  const current = getAgentOperationInternal(operationId);
  if (!current) return;
  const logs = [...(current.logs || []), {
    timestamp: new Date().toISOString(),
    level,
    stage,
    message: redactAgentText(message),
  }].slice(-300);
  updateAgentOperationInternal(operationId, { logs });
}

/** 更新任务进度。 */
function updateOperationProgress(operationId, stage, percent, message) {
  updateAgentOperationInternal(operationId, { progress: { stage, percent, message: redactAgentText(message) } });
  appendOperationLog(operationId, 'info', message, stage);
}

/** 将待审批任务放入后台执行队列。 */
function queueAgentOperation(operation, approvedBy, auditAction = 'operation_approved') {
  if (operation.status !== 'pending_approval') return operation;
  const updated = updateAgentOperation(operation.id, {
    status: 'queued',
    approvedBy,
    approvedAt: new Date().toISOString(),
  });
  appendAgentAudit({
    action: auditAction,
    operationId: operation.id,
    toolName: operation.toolName,
    client: operation.client,
    approvedBy,
    payloadHash: operation.payloadHash,
  });
  setImmediate(() => void runApprovedOperation(operation.id));
  return updated;
}

/** 创建受审批策略控制的幂等操作。 */
function createPendingOperation({ toolName, client, workspacePath = '', riskLevel, executionScope, idempotencyKey, payload, approvalSummary, projectGrantValidated = false }) {
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    throw new AgentError('idempotency_key_required', '写操作必须提供 idempotencyKey');
  }
  const payloadHash = hashAgentPayload(payload);
  const operation = createAgentOperation({
    toolName,
    client,
    workspacePath,
    riskLevel,
    executionScope,
    idempotencyKey,
    payloadHash,
    payload,
    approvalSummary,
  });
  appendAgentAudit({
    action: 'operation_requested',
    operationId: operation.id,
    toolName,
    client,
    workspacePath,
    riskLevel,
    executionScope,
    payloadHash,
    parameterSummary: approvalSummary,
  });
  const policy = getAgentApprovalPolicy();
  const runtimePolicy = getAgentRuntimeSettings();
  const canAutoApprove = policy.autoApproveGrantedProjects
    && projectGrantValidated
    && Boolean(workspacePath)
    && riskLevel !== 'destructive'
    && toolName !== 'yuyan_authorize_workspace'
    && runtimePolicy.accountApprovalPolicyReady
    && !runtimePolicy.forcedApprovalTools.includes(toolName);
  return canAutoApprove
    ? queueAgentOperation(operation, 'policy:trusted-project', 'operation_auto_approved')
    : operation;
}

/** 为未授权项目创建一次授权审批。 */
function createAuthorizationOperation(client, workspace) {
  return createPendingOperation({
    toolName: 'yuyan_authorize_workspace',
    client,
    workspacePath: workspace.workspacePath,
    riskLevel: 'config_write',
    executionScope: 'local',
    idempotencyKey: `authorize:${hashAgentPayload({ client, path: workspace.workspacePath, remote: workspace.remoteUrl })}`,
    payload: { workspace },
    approvalSummary: {
      title: '授权 AI 客户端访问项目',
      client,
      workspacePath: workspace.workspacePath,
      remoteUrl: workspace.remoteUrl,
      permissions: ['read', 'config_write', 'external_effect'],
    },
  });
}

/** 在需要授权时返回可审批 operation，而不是泄露项目数据。 */
async function withProjectGrant(client, workspacePath, handler) {
  try {
    const context = await requireProjectGrant(client, workspacePath);
    return await handler(context);
  } catch (error) {
    if (error?.code !== 'authorization_required') throw error;
    const workspace = error.details?.workspace || await inspectAgentWorkspace(workspacePath);
    const operation = createAuthorizationOperation(client, workspace);
    return {
      authorizationRequired: true,
      operation,
      message: '请在雨燕中确认该项目授权，批准后重新调用当前工具。',
    };
  }
}

/** 读取部署目标映射到保存参数后的原始配置值。 */
function getTargetConfigValue(target, key) {
  if (!target) return null;
  if (key === 'serverName') return target.nginxServerName ?? '';
  return target[key] ?? null;
}

/** 生成前端或后端部署配置候选。 */
async function buildProjectConfigPlan(workspace, args) {
  const { data: targets, executionScope: configScope } = await callYuyanApi('/deploy-api/targets', { scope: 'server' });
  const existing = (Array.isArray(targets) ? targets : []).find((target) =>
    (workspace.remoteUrl && String(target.repositoryUrl || '').toLowerCase().replace(/\.git$/, '').includes(workspace.remoteUrl))
    || String(target.projectPath || '') === workspace.projectName
    || String(target.projectName || '') === workspace.projectName
  ) || null;
  const { data: servers } = await callYuyanApi('/deploy-api/servers', { scope: 'server' });
  const serverId = Number(args.serverId || existing?.serverId || 0);
  const server = (Array.isArray(servers) ? servers : []).find((item) => Number(item.id) === serverId) || null;
  const targetOverrides = args.target || {};
  const packageManager = workspace.packageManager || 'pnpm';
  const projectType = workspace.projectType;
  const projectName = String(args.projectName || workspace.projectName);
  const isBackend = projectType === 'backend';
  const defaultInstance = server?.nginxInstances?.find((item) => item.isDefault) || server?.nginxInstances?.[0];
  const proposed = {
    projectSource: existing?.projectSource || 'gitlab',
    projectId: Number(args.projectId || existing?.projectId || 0),
    projectName,
    projectDescription: String(args.description || existing?.projectDescription || ''),
    projectPath: String(args.projectPath || existing?.projectPath || projectName),
    repositoryUrl: String(args.repositoryUrl || existing?.repositoryUrl || workspace.remoteUrl || ''),
    defaultBranch: String(args.branch || workspace.branch || existing?.defaultBranch || 'dev'),
    envName: String(args.envName || existing?.envName || '测试'),
    serverId,
    nginxInstanceId: isBackend ? 0 : Number(args.nginxInstanceId || existing?.nginxInstanceId || defaultInstance?.id || 0),
    deployRoot: String(targetOverrides.deployRoot || existing?.deployRoot || `${isBackend ? server?.defaultBackendRoot : server?.defaultDeployRoot || ''}/${projectName}`.replace(/\/+/g, '/')),
    nginxConfPath: isBackend ? '' : String(targetOverrides.nginxConfPath || existing?.nginxConfPath || server?.defaultNginxConfPath || ''),
    nginxSiteManaged: isBackend ? false : Boolean(targetOverrides.nginxSiteManaged ?? existing?.nginxSiteManaged ?? true),
    listenPort: isBackend ? 0 : Number(targetOverrides.listenPort || existing?.listenPort || 0),
    serverName: isBackend ? '' : String(targetOverrides.serverName || existing?.nginxServerName || '_'),
    enableNginxTest: isBackend ? false : Boolean(existing?.enableNginxTest ?? true),
    enableNginxReload: isBackend ? false : Boolean(existing?.enableNginxReload ?? true),
    installCommand: String(targetOverrides.installCommand ?? existing?.installCommand ?? (isBackend ? '' : `${packageManager} install`)),
    buildCommand: String(targetOverrides.buildCommand ?? existing?.buildCommand ?? (isBackend ? (workspace.packageScripts?.includes('mvnw') ? './mvnw -DskipTests package' : 'mvn -DskipTests package') : `${packageManager} build`)),
    artifactDir: String(targetOverrides.artifactDir ?? existing?.artifactDir ?? (isBackend ? 'target/*.jar' : 'dist')),
    preserveSubDirs: String(existing?.preserveSubDirs || ''),
    uploadStrategy: existing?.uploadStrategy || 'overlayKeepAssets',
    visitUrl: String(targetOverrides.visitUrl || existing?.visitUrl || ''),
    remark: String(targetOverrides.remark || existing?.remark || '由雨燕 MCP 规划'),
    projectType,
    jdkId: Number(existing?.jdkId || 0),
    stopCommand: existing?.stopCommand || '',
    startCommand: existing?.startCommand || '',
    healthCheckUrl: existing?.healthCheckUrl || '',
    serviceRole: existing?.serviceRole || 'application',
    environmentId: Number(existing?.environmentId || 0),
    serviceName: existing?.serviceName || projectName,
    buildJdkId: Number(existing?.buildJdkId || existing?.jdkId || 0),
    requiredJdkAlias: existing?.requiredJdkAlias || workspace.javaVersion || '',
    serverJavaRuntimeId: Number(existing?.serverJavaRuntimeId || 0),
    runtimeJavaHome: existing?.runtimeJavaHome || '',
    runtimeJavaVersion: existing?.runtimeJavaVersion || '',
    serverPort: Number(targetOverrides.serverPort || existing?.serverPort || 8080),
    springProfiles: existing?.springProfiles || '',
    externalConfigPath: existing?.externalConfigPath || '',
    jvmOptions: existing?.jvmOptions || '',
    appArgs: existing?.appArgs || '',
    processMode: existing?.processMode || 'pid',
    stopTimeoutSeconds: Number(existing?.stopTimeoutSeconds || 30),
    startupTimeoutSeconds: Number(existing?.startupTimeoutSeconds || 90),
    healthCheckPath: existing?.healthCheckPath || '/actuator/health',
    nacosServerAddr: existing?.nacosServerAddr || '',
    nacosConsoleUrl: existing?.nacosConsoleUrl || '',
    nacosNamespace: existing?.nacosNamespace || '',
    nacosGroup: existing?.nacosGroup || '',
    requireNacosRegistration: Boolean(existing?.requireNacosRegistration),
    gatewayUrl: existing?.gatewayUrl || '',
    gatewayProbePath: existing?.gatewayProbePath || '',
    artifactPattern: existing?.artifactPattern || (isBackend ? 'target/*.jar' : ''),
    openapiCommand: existing?.openapiCommand || '',
    openapiOutputPath: existing?.openapiOutputPath || '',
    needsReview: false,
  };
  const baseConfigSnapshot = existing
    ? Object.keys(proposed).reduce((snapshot, key) => {
      snapshot[key] = getTargetConfigValue(existing, key);
      return snapshot;
    }, {})
    : null;
  const diff = Object.entries(proposed)
    .filter(([key, value]) => JSON.stringify(getTargetConfigValue(existing, key)) !== JSON.stringify(value))
    .map(([field, after]) => ({ field, before: getTargetConfigValue(existing, field), after }));
  const missingFields = [
    !proposed.projectId && 'projectId',
    !proposed.serverId && 'serverId',
    !proposed.repositoryUrl && 'repositoryUrl',
    !isBackend && !proposed.nginxInstanceId && 'nginxInstanceId',
  ].filter(Boolean);
  return {
    action: existing ? 'update' : 'create',
    targetId: existing?.id || null,
    configScope,
    executionScope: isBackend ? 'local' : 'server',
    workspaceCommitSha: workspace.commitSha,
    baseConfigHash: hashAgentPayload(baseConfigSnapshot),
    proposed,
    diff,
    missingFields,
    readyToApply: missingFields.length === 0,
  };
}

/** 执行脚手架流式接口并同步进度。 */
async function executeScaffoldOperation(operation, payload, signal) {
  const settings = getAgentRuntimeSettings({ includeSecrets: true });
  if (payload.createRepo && !settings.hasGitlabCredential) {
    throw new AgentError('credential_required', '创建 GitLab 仓库需要先在雨燕登录 GitLab');
  }
  const response = await fetch(`http://127.0.0.1:${PORT}/scaffold-api/create?stream=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
    body: JSON.stringify({
      ...payload,
      gitlabHost: settings.gitlabHost,
      gitlabToken: settings.gitlabToken,
    }),
    signal,
  });
  if (!response.ok || !response.body) {
    const errorBody = await response.text();
    throw new AgentError('scaffold_failed', redactAgentText(errorBody || `脚手架接口返回 HTTP ${response.status}`));
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;
  const consume = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'stage') updateOperationProgress(operation.id, event.stage, event.percent, event.message);
    if (event.type === 'log') appendOperationLog(operation.id, event.level || 'info', event.message, event.stage || 'scaffold');
    if (event.type === 'result') result = event.data;
    if (event.type === 'error') throw new AgentError('scaffold_failed', event.message || '创建微应用失败');
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      consume(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);
  if (!result) throw new AgentError('scaffold_failed', '创建流程未返回最终结果');
  return result;
}

/** 为成功任务生成供 Agent 明确复述的统一执行回执。 */
function createExecutionReport(operation, payload, result) {
  const reportMeta = {
    yuyan_authorize_workspace: { summary: `已授权 ${operation.client} 访问项目`, objectType: 'workspace', objectId: operation.workspacePath, changes: ['新增或刷新项目访问授权'] },
    yuyan_apply_project_config: { summary: '已应用项目部署配置', objectType: 'deploy_target', objectId: result?.id || '', changes: ['创建或更新雨燕部署目标配置'] },
    yuyan_create_microapp: { summary: `已创建微应用 ${payload.appName || ''}`.trim(), objectType: 'microapp', objectId: payload.appName || '', changes: [payload.createRepo ? '生成脚手架并创建 GitLab 仓库' : '生成微应用脚手架'] },
    yuyan_deploy_target: { summary: `已发布部署目标 ${payload.targetId}`, objectType: 'deploy_target', objectId: payload.targetId, changes: [`发布分支 ${payload.branch || '-'}`, `绑定 Commit ${payload.commitSha || '-'}`] },
    yuyan_rollback_deployment: { summary: `已回滚发布记录 ${payload.recordId}`, objectType: 'deployment_record', objectId: payload.recordId, changes: ['恢复指定历史发布版本'] },
    yuyan_control_service: { summary: `已${payload.action || '控制'}服务目标 ${payload.targetId}`, objectType: 'service', objectId: payload.targetId, changes: [`执行受控服务动作 ${payload.action}`] },
    yuyan_generate_openapi: { summary: `已为目标 ${payload.targetId} 生成 OpenAPI`, objectType: 'openapi', objectId: payload.targetId, changes: [`生成分支 ${payload.branch || '-'}`, payload.force ? '强制刷新缓存' : '允许复用有效缓存'] },
    yuyan_delete_deploy_target: { summary: `已删除部署目标 ${payload.projectName}`, objectType: 'deploy_target', objectId: payload.targetId, changes: ['删除目标配置、关联发布历史、任务记录和 OpenAPI 产物索引'] },
    yuyan_delete_deploy_server: { summary: `已删除空闲部署服务器 ${payload.serverName}`, objectType: 'deploy_server', objectId: payload.serverId, changes: ['删除服务器、Nginx 实例和运行时配置'] },
  }[operation.toolName] || { summary: `已执行 ${operation.toolName}`, objectType: 'operation', objectId: operation.id, changes: [] };
  const verification = [];
  if (result?.health) verification.push(`健康检查：${result.health}`);
  if (result?.status) verification.push(`最终状态：${result.status}`);
  if (result?.recordId) verification.push(`发布记录：${result.recordId}`);
  return {
    summary: reportMeta.summary,
    action: operation.toolName,
    executionScope: operation.executionScope === 'server' ? 'central' : 'device',
    actor: operation.actor,
    object: { type: reportMeta.objectType, id: reportMeta.objectId },
    changes: reportMeta.changes.filter(Boolean),
    verification,
    completedAt: new Date().toISOString(),
  };
}

/** 合并领域结果与统一执行回执。 */
function attachExecutionReport(operation, payload, result) {
  const safeResult = redactAgentValue(result);
  const domainResult = safeResult && typeof safeResult === 'object' && !Array.isArray(safeResult)
    ? safeResult
    : { value: safeResult };
  return {
    ...domainResult,
    executionReport: domainResult.executionReport || createExecutionReport(operation, payload, safeResult),
  };
}

/** 执行一个已批准操作。 */
async function runApprovedOperation(operationId) {
  const operation = getAgentOperationInternal(operationId);
  const payload = getAgentOperationPayloadInternal(operationId);
  if (!operation || !payload || operation.status !== 'queued') return;
  const currentSettings = getAgentRuntimeSettings();
  if (!currentSettings.loggedIn
    || currentSettings.accountId !== operation.actor?.accountId
    || currentSettings.deviceId !== operation.actor?.deviceId
    || currentSettings.teamId !== operation.actor?.teamId) {
    updateAgentOperationInternal(operationId, { status: 'expired', error: { code: 'identity_changed', message: '账号或设备已变化，任务未执行', retryable: true } });
    return;
  }
  if (operation.riskLevel === 'destructive' && currentSettings.role !== 'admin') {
    updateAgentOperationInternal(operationId, { status: 'expired', error: { code: 'admin_required', message: '当前账号无权执行删除操作', retryable: false } });
    return;
  }
  if (OPERATOR_TOOL_NAMES.has(operation.toolName) && !['operator', 'admin'].includes(currentSettings.role)) {
    updateAgentOperationInternal(operationId, { status: 'expired', error: { code: 'forbidden_role', message: '当前账号已无权执行该操作', retryable: false } });
    return;
  }
  if (hashAgentPayload(payload) !== operation.payloadHash) {
    updateAgentOperationInternal(operationId, { status: 'expired', error: { code: 'approval_payload_changed', message: '审批参数已变化，旧审批已作废', retryable: true } });
    return;
  }
  if (operation.toolName !== 'yuyan_authorize_workspace' && operation.workspacePath) {
    try {
      const { workspace } = await requireProjectGrant(operation.client, operation.workspacePath);
      if (payload.targetId) {
        const { target } = await getConfiguredTarget(payload.targetId);
        requireTargetWorkspaceMatch(target, workspace);
      }
    } catch (error) {
      updateAgentOperationInternal(operationId, {
        status: 'expired',
        error: {
          code: error?.code === 'authorization_required' ? 'authorization_revoked' : error?.code || 'authorization_recheck_failed',
          message: error?.code === 'authorization_required' ? '项目授权已撤销，任务未执行' : redactAgentText(error?.message || '项目授权复核失败'),
          retryable: true,
        },
      });
      appendAgentAudit({ action: 'operation_authorization_expired', operationId, toolName: operation.toolName, client: operation.client, actor: operation.actor });
      return;
    }
  }
  const controller = new AbortController();
  activeOperationControllers.set(operationId, { controller, actor: operation.actor });
  updateAgentOperationInternal(operationId, { status: 'running', progress: { stage: 'start', percent: 2, message: '已进入雨燕执行队列' } });
  appendAgentAudit({ action: 'operation_started', operationId, toolName: operation.toolName, client: operation.client, payloadHash: operation.payloadHash, actor: operation.actor });
  try {
    let result;
    if (operation.toolName === 'yuyan_authorize_workspace') {
      result = upsertProjectGrant({
        client: operation.client,
        workspacePath: payload.workspace.workspacePath,
        remoteUrl: payload.workspace.remoteUrl,
      });
    } else if (operation.toolName === 'yuyan_apply_project_config') {
      const plan = getAgentPlan(payload.planId, operation.client);
      if (!plan || plan.payloadHash !== payload.planHash || hashAgentPayload(plan.data) !== plan.payloadHash) {
        throw new AgentError('plan_expired', '配置计划已过期或内容发生变化，请重新规划');
      }
      if (!plan.data.readyToApply) throw new AgentError('config_incomplete', `配置仍缺少：${plan.data.missingFields.join('、')}`);
      const currentWorkspace = await inspectAgentWorkspace(operation.workspacePath);
      if (currentWorkspace.commitSha !== plan.data.workspaceCommitSha) {
        throw new AgentError('commit_changed', '当前项目 Commit 已变化，配置审批已作废');
      }
      const { data: currentTargets } = await callYuyanApi('/deploy-api/targets', { scope: 'server', signal: controller.signal });
      const currentTargetList = Array.isArray(currentTargets) ? currentTargets : [];
      const currentTarget = plan.data.targetId
        ? currentTargetList.find((item) => Number(item.id) === Number(plan.data.targetId)) || null
        : currentTargetList.find((item) =>
          (plan.data.proposed.repositoryUrl && String(item.repositoryUrl || '') === String(plan.data.proposed.repositoryUrl))
          || String(item.projectPath || '') === String(plan.data.proposed.projectPath)
        ) || null;
      const currentConfigSnapshot = currentTarget
        ? Object.keys(plan.data.proposed).reduce((snapshot, key) => {
          snapshot[key] = getTargetConfigValue(currentTarget, key);
          return snapshot;
        }, {})
        : null;
      if (hashAgentPayload(currentConfigSnapshot) !== plan.data.baseConfigHash) {
        throw new AgentError('config_changed', '部署配置已在审批期间发生变化，请重新生成差异');
      }
      updateOperationProgress(operationId, 'apply', 35, '正在应用部署配置');
      const route = plan.data.targetId ? `/deploy-api/targets/${plan.data.targetId}` : '/deploy-api/targets';
      result = (await callYuyanApi(route, {
        scope: 'server',
        method: plan.data.targetId ? 'PUT' : 'POST',
        body: plan.data.proposed,
        signal: controller.signal,
      })).data;
    } else if (operation.toolName === 'yuyan_create_microapp') {
      result = await executeScaffoldOperation(operation, payload, controller.signal);
    } else if (operation.toolName === 'yuyan_deploy_target') {
      if (payload.workspacePath && payload.commitSha) {
        const current = await inspectAgentWorkspace(payload.workspacePath);
        if (current.commitSha !== payload.commitSha) throw new AgentError('commit_changed', '当前项目 Commit 已变化，部署审批已作废');
      }
      const settings = getAgentRuntimeSettings({ includeSecrets: true });
      if (!settings.hasGitlabCredential) throw new AgentError('credential_required', '发布需要先在雨燕登录 GitLab');
      const { target } = await getConfiguredTarget(payload.targetId);
      updateOperationProgress(operationId, 'deploy', 8, `正在发布目标 ${payload.targetId}`);
      result = target.projectType === 'backend'
        ? await deployBackendViaCentral(operation, payload, target, settings, controller.signal)
        : (await callYuyanApi(`/deploy-api/targets/${payload.targetId}/deploy`, {
            scope: 'server',
            method: 'POST',
            body: { branch: payload.branch, gitlabToken: settings.gitlabToken, operator: `mcp:${operation.client}` },
            signal: controller.signal,
          })).data;
    } else if (operation.toolName === 'yuyan_rollback_deployment') {
      updateOperationProgress(operationId, 'rollback', 25, `正在回滚发布记录 ${payload.recordId}`);
      result = (await callYuyanApi(`/deploy-api/records/${payload.recordId}/rollback`, {
        scope: 'server', method: 'POST', body: { operator: `mcp:${operation.client}` }, signal: controller.signal,
      })).data;
    } else if (operation.toolName === 'yuyan_control_service') {
      updateOperationProgress(operationId, payload.action, 30, `正在${payload.action}服务`);
      result = (await callYuyanApi(`/deploy-api/targets/${payload.targetId}/service-actions/${payload.action}`, {
        scope: 'server', method: 'POST', body: {}, signal: controller.signal,
      })).data;
    } else if (operation.toolName === 'yuyan_generate_openapi') {
      const settings = getAgentRuntimeSettings({ includeSecrets: true });
      if (!settings.hasGitlabCredential) throw new AgentError('credential_required', '生成 OpenAPI 需要先在雨燕登录 GitLab');
      updateOperationProgress(operationId, 'openapi', 15, '正在生成 OpenAPI');
      const { target } = await getConfiguredTarget(payload.targetId);
      const isolatedTarget = {
        ...target,
        id: `${hashAgentPayload({ accountId: operation.actor.accountId, teamId: operation.actor.teamId }).slice(0, 16)}-openapi-${target.id}`,
      };
      const artifact = await generateOpenApiFromTargetConfig(isolatedTarget, {
        sourceTargetId: Number(target.id),
        branch: payload.branch,
        force: payload.force,
        gitlabToken: settings.gitlabToken,
        signal: controller.signal,
        findCached: async (branch, commitSha) => {
          const cached = getLatestDeviceOpenApiArtifact(target.id, branch, { includePath: true });
          return cached?.commitSha === commitSha ? cached : null;
        },
        log: (level, message, stage) => appendOperationLog(operationId, level, message, stage),
      });
      result = saveDeviceOpenApiArtifact(artifact);
    } else if (operation.toolName === 'yuyan_delete_deploy_target') {
      const { target } = await getConfiguredTarget(payload.targetId);
      if (getTargetIdentityHash(target) !== payload.identityHash) {
        throw new AgentError('destructive_target_changed', '部署目标身份或服务器绑定已变化，旧删除审批已作废');
      }
      updateOperationProgress(operationId, 'delete', 35, `正在删除部署目标 ${payload.projectName}`);
      result = (await callYuyanApi(`/deploy-api/targets/${payload.targetId}?safe=1&expectedName=${encodeURIComponent(payload.projectName)}`, {
        scope: 'server', method: 'DELETE', signal: controller.signal,
      })).data;
    } else if (operation.toolName === 'yuyan_delete_deploy_server') {
      const { server } = await getConfiguredServer(payload.serverId);
      if (getServerIdentityHash(server) !== payload.identityHash) {
        throw new AgentError('destructive_target_changed', '服务器名称、主机或端口已变化，旧删除审批已作废');
      }
      const { data: targets } = await callYuyanApi(`/deploy-api/targets?serverId=${payload.serverId}`, { scope: 'server', signal: controller.signal });
      if ((Array.isArray(targets) ? targets : []).some((item) => Number(item.serverId) === Number(payload.serverId))) {
        throw new AgentError('server_in_use', '服务器仍被部署目标引用，请先逐个删除目标');
      }
      updateOperationProgress(operationId, 'delete', 35, `正在删除空闲服务器 ${payload.serverName}`);
      result = (await callYuyanApi(`/deploy-api/servers/${payload.serverId}?requireEmpty=1&expectedName=${encodeURIComponent(payload.serverName)}`, {
        scope: 'server', method: 'DELETE', signal: controller.signal,
      })).data;
    } else {
      throw new AgentError('tool_not_executable', `未注册写工具执行器：${operation.toolName}`);
    }
    const reportedResult = attachExecutionReport(operation, payload, result);
    updateAgentOperationInternal(operationId, { status: 'succeeded', progress: { stage: 'finish', percent: 100, message: reportedResult.executionReport.summary }, result: reportedResult });
    appendAgentAudit({ action: 'operation_succeeded', operationId, toolName: operation.toolName, client: operation.client, resultSummary: reportedResult.executionReport, actor: operation.actor });
  } catch (error) {
    const cancelled = controller.signal.aborted;
    updateAgentOperationInternal(operationId, {
      status: cancelled ? 'cancelled' : 'failed',
      error: cancelled ? { code: 'cancelled', message: '任务已取消', retryable: true } : serializeAgentError(error),
    });
    appendAgentAudit({ action: cancelled ? 'operation_cancelled' : 'operation_failed', operationId, toolName: operation.toolName, client: operation.client, error: serializeAgentError(error), actor: operation.actor });
  } finally {
    activeOperationControllers.delete(operationId);
  }
}

/** 批准并异步执行操作。 */
export function approveAgentOperation(operationId, approvedBy = 'local-user') {
  const operation = getAgentOperation(operationId);
  if (!operation) throw new AgentError('operation_not_found', '操作不存在');
  if (operation.status !== 'pending_approval') throw new AgentError('operation_not_pending', '操作当前不在待审批状态');
  return queueAgentOperation(operation, approvedBy);
}

/** 拒绝待审批操作。 */
export function rejectAgentOperation(operationId, approvedBy = 'local-user') {
  const operation = getAgentOperation(operationId);
  if (!operation) throw new AgentError('operation_not_found', '操作不存在');
  if (operation.status !== 'pending_approval') throw new AgentError('operation_not_pending', '操作当前不在待审批状态');
  const updated = updateAgentOperation(operationId, {
    status: 'rejected', approvedBy, approvedAt: new Date().toISOString(), error: { code: 'rejected', message: '用户已拒绝该操作', retryable: false },
  });
  appendAgentAudit({ action: 'operation_rejected', operationId, toolName: operation.toolName, client: operation.client, approvedBy });
  return updated;
}

/**
 * 由雨燕部署页面显式点击后创建后端“设备构建、中央部署”任务。
 * @description 该入口不冒充 MCP 项目授权；用户当前 UI 动作本身作为本次确认，并完整进入任务与审计链。
 */
export async function createDesktopBackendDeployOperation(targetId, branch, idempotencyKey) {
  const settings = getAgentRuntimeSettings();
  if (!settings.centralSessionReady) throw new AgentError('central_session_required', '中央会话未就绪，请重新登录雨燕');
  if (!['operator', 'admin'].includes(settings.role)) throw new AgentError('forbidden_role', '当前账号无权发布');
  const { target } = await getConfiguredTarget(targetId);
  if (target.projectType !== 'backend') throw new AgentError('invalid_project_type', '该入口仅用于后端目标');
  const payload = {
    targetId: Number(targetId),
    branch: String(branch || target.defaultBranch || '').trim(),
    commitSha: '',
  };
  if (!payload.branch) throw new AgentError('branch_required', '发布分支不能为空');
  const operation = createPendingOperation({
    toolName: 'yuyan_deploy_target',
    client: 'generic',
    riskLevel: 'external_effect',
    executionScope: 'server',
    idempotencyKey,
    payload,
    approvalSummary: {
      title: '雨燕桌面端发布后端目标',
      targetId: target.id,
      projectName: target.projectName,
      branch: payload.branch,
      phases: ['device_build', 'central_deploy'],
    },
  });
  return operation.status === 'pending_approval'
    ? queueAgentOperation(operation, 'desktop:user-confirmed', 'operation_desktop_confirmed')
    : operation;
}

/** 从部署页显式创建当前设备 OpenAPI 生成任务。 */
export async function createDesktopOpenApiOperation(targetId, branch, force, idempotencyKey) {
  const settings = getAgentRuntimeSettings();
  if (!settings.centralSessionReady) throw new AgentError('central_session_required', '中央会话未就绪，请重新登录雨燕');
  if (!['operator', 'admin'].includes(settings.role)) throw new AgentError('forbidden_role', '当前账号无权生成 OpenAPI');
  const { target } = await getConfiguredTarget(targetId);
  if (target.projectType !== 'backend') throw new AgentError('invalid_project_type', '仅后端目标支持 OpenAPI 生成');
  const payload = { targetId: Number(targetId), branch: String(branch || target.defaultBranch || '').trim(), force: Boolean(force) };
  const operation = createPendingOperation({
    toolName: 'yuyan_generate_openapi', client: 'generic', riskLevel: 'external_effect', executionScope: 'local', idempotencyKey,
    payload, approvalSummary: { title: '雨燕桌面端生成 OpenAPI', targetId: target.id, projectName: target.projectName, branch: payload.branch },
  });
  return operation.status === 'pending_approval'
    ? queueAgentOperation(operation, 'desktop:user-confirmed', 'operation_desktop_confirmed')
    : operation;
}

/** 返回当前设备的 OpenAPI 产物元数据。 */
export function getDesktopOpenApiArtifact(targetId, branch = '') {
  return getLatestDeviceOpenApiArtifact(targetId, branch);
}

/** 读取当前设备的 OpenAPI 内容，绝对路径不返回 WebView。 */
export async function readDesktopOpenApiArtifact(id) {
  const artifact = getDeviceOpenApiArtifact(id, { includePath: true });
  if (!artifact) throw new AgentError('openapi_artifact_not_found', '当前设备没有该 OpenAPI 产物');
  const [realRoot, realFile] = await Promise.all([
    fs.realpath(DEPLOY_OPENAPI_DIR).catch(() => path.resolve(DEPLOY_OPENAPI_DIR)),
    fs.realpath(artifact.filePath).catch(() => ''),
  ]);
  if (!realFile || (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`))) {
    throw new AgentError('openapi_artifact_path_invalid', 'OpenAPI 缓存路径已失效或越出雨燕数据目录');
  }
  const content = await fs.readFile(realFile, 'utf8').catch(() => '');
  if (!content) throw new AgentError('openapi_artifact_missing', 'OpenAPI 缓存文件已不存在，请重新生成');
  return { artifact: getDeviceOpenApiArtifact(id), content };
}

/** 账号或设备切换时中止该身份仍在本机执行的可取消任务。 */
export function abortAgentOperationsForIdentity(identity) {
  let aborted = 0;
  for (const entry of activeOperationControllers.values()) {
    if (entry.actor?.accountId !== identity?.accountId || entry.actor?.deviceId !== identity?.deviceId) continue;
    entry.controller.abort();
    aborted += 1;
  }
  return aborted;
}

/** 取消待审批、排队中或可安全停止的运行任务。 */
export async function cancelAgentOperation(operationId) {
  const operation = getAgentOperation(operationId);
  if (!operation) throw new AgentError('operation_not_found', '操作不存在');
  if (operation.status === 'cancelled') return operation;
  if (['pending_approval', 'queued'].includes(operation.status)) {
    const updated = updateAgentOperation(operationId, { status: 'cancelled', error: { code: 'cancelled', message: '任务已取消', retryable: true } });
    appendAgentAudit({ action: 'operation_cancelled', operationId, toolName: operation.toolName, client: operation.client });
    return updated;
  }
  if (operation.status !== 'running') throw new AgentError('operation_not_cancellable', '当前任务状态不可取消');
  activeOperationControllers.get(operationId)?.controller.abort();
  const payload = getAgentOperationPayload(operationId);
  const centralOperationId = String(operation.result?.centralOperationId || '');
  if (centralOperationId) {
    await callYuyanApi(`/deploy-api/operations/${encodeURIComponent(centralOperationId)}/cancel`, {
      scope: 'server', method: 'POST', body: {},
    }).catch(() => undefined);
  }
  if (operation.toolName === 'yuyan_deploy_target' || operation.toolName === 'yuyan_generate_openapi') {
    if (!centralOperationId) {
      await callYuyanApi(`/deploy-api/targets/${payload.targetId}/deploy/stop`, { scope: 'local', method: 'POST', body: {} }).catch(() => undefined);
    }
  }
  const updated = updateAgentOperation(operationId, { status: 'cancelled', error: { code: 'cancelled', message: '已请求安全停止任务', retryable: true } });
  appendAgentAudit({ action: 'operation_cancelled', operationId, toolName: operation.toolName, client: operation.client });
  return updated;
}

/**
 * 执行 MCP 工具命令。
 * @param {string} toolName 工具名
 * @param {string} client 客户端标识
 * @param {Record<string, unknown>} args 严格校验后的参数
 * @returns {Promise<unknown>} 工具结构化结果
 */
export async function executeAgentTool(toolName, client, args = {}) {
  const normalizedClient = normalizeAgentClient(client);
  const settings = getAgentRuntimeSettings();
  if (toolName === 'yuyan_get_status') {
    return {
      serverName: 'yuyan-mcp-server',
      appRunning: true,
      gatewayReady: true,
      client: normalizedClient,
      executionContext: settings,
      approvalPolicy: getAgentApprovalPolicy(),
      pendingApprovals: listAgentOperations({ status: 'pending_approval', client: normalizedClient, limit: 100 }).total,
      auditChain: verifyAgentAuditChain(),
      limitedMode: !settings.centralSessionReady,
      nextAction: !settings.loggedIn ? '请打开雨燕并登录 GitLab' : !settings.centralSessionReady ? '请刷新账号会话' : '',
    };
  }
  if (toolName === 'yuyan_inspect_workspace') {
    if (!settings.loggedIn) {
      return {
        workspace: await inspectAgentWorkspace(args.workspacePath),
        authorization: null,
        limitedMode: true,
        message: '当前仅完成本地只读识别；请打开雨燕登录后再授权或执行操作。',
      };
    }
    return withProjectGrant(normalizedClient, args.workspacePath, async ({ workspace, grant }) => ({ workspace, authorization: grant }));
  }
  if (!settings.loggedIn) throw new AgentError('login_required', '请先打开雨燕并登录 GitLab', { retryable: true });
  if (toolName === 'yuyan_search_projects') {
    const offset = decodeCursor(args.cursor);
    const limit = Math.min(100, Math.max(1, Number(args.limit || 20)));
    const result = listProjectGrants({ client: normalizedClient, keyword: String(args.keyword || ''), limit, offset });
    return { ...result, nextCursor: offset + result.items.length < result.total ? encodeCursor(offset + result.items.length) : null };
  }
  if (toolName === 'yuyan_get_operation') {
    const operation = getAgentOperation(String(args.operationId || ''));
    if (!operation || operation.client !== normalizedClient) throw new AgentError('operation_not_found', '操作不存在或不属于当前客户端');
    return operation;
  }
  if (toolName === 'yuyan_cancel_operation') {
    const operation = getAgentOperation(String(args.operationId || ''));
    if (!operation || operation.client !== normalizedClient) throw new AgentError('operation_not_found', '操作不存在或不属于当前客户端');
    return cancelAgentOperation(operation.id);
  }
  if (!settings.centralSessionReady) {
    throw new AgentError('central_session_required', '中央会话未就绪；离线模式仅允许项目识别、授权查询和任务查询/取消', { retryable: true });
  }
  if (OPERATOR_TOOL_NAMES.has(toolName) && !['operator', 'admin'].includes(settings.role)) {
    throw new AgentError('forbidden_role', '当前账号无权执行该操作');
  }

  return withProjectGrant(normalizedClient, args.workspacePath, async ({ workspace }) => {
    /** 创建已通过项目授权校验的写任务。 */
    const createGrantedOperation = (options) => createPendingOperation({ ...options, projectGrantValidated: true });
    if (toolName === 'yuyan_list_deploy_servers') {
      const { data, executionScope } = await callYuyanApi('/deploy-api/servers', { scope: 'server' });
      return { ...paginateItems(redactAgentValue(Array.isArray(data) ? data : []), args), executionScope };
    }
    if (toolName === 'yuyan_list_deploy_targets') {
      const search = new URLSearchParams();
      if (args.keyword) search.set('keyword', String(args.keyword));
      if (args.projectType) search.set('projectType', String(args.projectType));
      const { data, executionScope } = await callYuyanApi(`/deploy-api/targets${search.size ? `?${search}` : ''}`, { scope: 'server' });
      return { ...paginateItems(redactAgentValue(Array.isArray(data) ? data : []), args), executionScope };
    }
    if (toolName === 'yuyan_get_deploy_history') {
      const pageSize = Math.min(100, Math.max(1, Number(args.limit || 20)));
      const page = Math.floor(decodeCursor(args.cursor) / pageSize) + 1;
      const search = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (args.targetId) {
        const { target } = await getConfiguredTarget(args.targetId);
        requireTargetWorkspaceMatch(target, workspace);
        search.set('targetId', String(args.targetId));
      }
      const { data, executionScope } = await callYuyanApi(`/deploy-api/records?${search}`, { scope: 'server' });
      const items = redactAgentValue(data?.items || []);
      return { items, total: data?.total || 0, nextCursor: page * pageSize < Number(data?.total || 0) ? encodeCursor(page * pageSize) : null, executionScope };
    }
    if (toolName === 'yuyan_plan_project_config') {
      const planData = await buildProjectConfigPlan(workspace, args);
      const payloadHash = hashAgentPayload(planData);
      const plan = createAgentPlan({ client: normalizedClient, workspacePath: workspace.workspacePath, toolName, payloadHash, data: planData });
      return { planId: plan.id, planHash: plan.payloadHash, expiresAt: plan.expiresAt, ...planData };
    }
    if (toolName === 'yuyan_apply_project_config') {
      const plan = getAgentPlan(String(args.planId || ''), normalizedClient);
      if (!plan || plan.workspacePath !== workspace.workspacePath) throw new AgentError('plan_expired', '配置计划不存在、已过期或不属于当前项目');
      return createGrantedOperation({
        toolName, client: normalizedClient, workspacePath: workspace.workspacePath, riskLevel: 'config_write', executionScope: plan.data.configScope,
        idempotencyKey: args.idempotencyKey, payload: { planId: plan.id, planHash: plan.payloadHash },
        approvalSummary: { title: `${plan.data.action === 'create' ? '创建' : '更新'}项目部署配置`, workspacePath: workspace.workspacePath, executionScope: plan.data.configScope, diff: plan.data.diff, missingFields: plan.data.missingFields },
      });
    }
    if (toolName === 'yuyan_create_microapp') {
      return createGrantedOperation({
        toolName, client: normalizedClient, workspacePath: workspace.workspacePath, riskLevel: 'external_effect', executionScope: 'local', idempotencyKey: args.idempotencyKey,
        payload: { ...args, workspacePath: undefined, idempotencyKey: undefined },
        approvalSummary: { title: '创建微应用', appName: args.appName, createRepo: Boolean(args.createRepo), namespaceId: args.namespaceId || '', visibility: args.visibility || 'private' },
      });
    }
    if (toolName === 'yuyan_preflight_deploy_target') {
      const { target, configScope } = await getConfiguredTarget(args.targetId);
      requireTargetWorkspaceMatch(target, workspace);
      const executionScope = 'server';
      return {
        target: redactAgentValue(target),
        configScope,
        executionScope,
        workspaceCommitSha: workspace.commitSha,
        branch: String(args.branch || workspace.branch || target.defaultBranch),
        phases: target.projectType === 'backend' ? ['device_build', 'central_deploy'] : ['central_build', 'central_deploy'],
        checks: [
          { key: 'workspace_clean', passed: !workspace.dirty, message: workspace.dirty ? '工作区存在未提交修改' : '工作区干净' },
          { key: 'commit_available', passed: Boolean(workspace.commitSha), message: workspace.commitSha || '无法读取 Commit' },
          { key: 'server_configured', passed: Boolean(target.serverId), message: target.serverName || '未配置服务器' },
        ],
      };
    }
    if (toolName === 'yuyan_deploy_target') {
      const { target } = await getConfiguredTarget(args.targetId);
      requireTargetWorkspaceMatch(target, workspace);
      const executionScope = 'server';
      const branch = String(args.branch || workspace.branch || target.defaultBranch);
      return createGrantedOperation({
        toolName, client: normalizedClient, workspacePath: workspace.workspacePath, riskLevel: 'external_effect', executionScope, idempotencyKey: args.idempotencyKey,
        payload: { targetId: Number(args.targetId), branch, commitSha: workspace.commitSha, workspacePath: workspace.workspacePath },
        approvalSummary: { title: '发布部署目标', targetId: target.id, projectName: target.projectName, projectType: target.projectType, server: `${target.serverName || ''} ${target.serverHost || ''}`.trim(), environment: target.envName, branch, commitSha: workspace.commitSha, buildCommand: target.buildCommand, deployRoot: target.deployRoot, executionScope },
      });
    }
    if (toolName === 'yuyan_rollback_deployment') {
      const { data: record } = await callYuyanApi(`/deploy-api/records/${Number(args.recordId)}`, { scope: 'server' });
      if (!record) throw new AgentError('record_not_found', '发布记录不存在');
      const { target } = await getConfiguredTarget(record.targetId);
      requireTargetWorkspaceMatch(target, workspace);
      return createGrantedOperation({
        toolName, client: normalizedClient, workspacePath: workspace.workspacePath, riskLevel: 'external_effect', executionScope: 'server', idempotencyKey: args.idempotencyKey,
        payload: { recordId: Number(args.recordId), targetId: Number(record.targetId) }, approvalSummary: { title: '回滚发布记录', recordId: Number(args.recordId), targetId: Number(record.targetId), projectName: target.projectName, executionScope: 'server' },
      });
    }
    if (toolName === 'yuyan_get_service_status') {
      const { target } = await getConfiguredTarget(args.targetId);
      requireTargetWorkspaceMatch(target, workspace);
      return (await callYuyanApi(`/deploy-api/targets/${Number(args.targetId)}/service-status`, { scope: 'server' })).data;
    }
    if (toolName === 'yuyan_read_service_logs') {
      const { target } = await getConfiguredTarget(args.targetId);
      requireTargetWorkspaceMatch(target, workspace);
      const lines = Math.min(1000, Math.max(10, Number(args.lines || 200)));
      return redactAgentValue((await callYuyanApi(`/deploy-api/targets/${Number(args.targetId)}/service-logs?lines=${lines}`, { scope: 'server' })).data);
    }
    if (toolName === 'yuyan_control_service') {
      const { target } = await getConfiguredTarget(args.targetId);
      requireTargetWorkspaceMatch(target, workspace);
      return createGrantedOperation({
        toolName, client: normalizedClient, workspacePath: workspace.workspacePath, riskLevel: 'external_effect', executionScope: 'server', idempotencyKey: args.idempotencyKey,
        payload: { targetId: Number(args.targetId), action: args.action }, approvalSummary: { title: '控制后端服务', targetId: Number(args.targetId), action: args.action, executionScope: 'server' },
      });
    }
    if (toolName === 'yuyan_generate_openapi') {
      const { target } = await getConfiguredTarget(args.targetId);
      requireTargetWorkspaceMatch(target, workspace);
      return createGrantedOperation({
        toolName, client: normalizedClient, workspacePath: workspace.workspacePath, riskLevel: 'external_effect', executionScope: 'local', idempotencyKey: args.idempotencyKey,
        payload: { targetId: Number(args.targetId), branch: String(args.branch || workspace.branch), force: Boolean(args.force) }, approvalSummary: { title: '生成 OpenAPI', targetId: Number(args.targetId), branch: String(args.branch || workspace.branch), force: Boolean(args.force), executionScope: 'local' },
      });
    }
    if (toolName === 'yuyan_delete_deploy_target') {
      if (settings.role !== 'admin') throw new AgentError('admin_required', '当前账号无权删除部署目标');
      const { target, configScope } = await getConfiguredTarget(args.targetId);
      requireTargetWorkspaceMatch(target, workspace);
      if (String(args.expectedProjectName || '').trim() !== String(target.projectName || '').trim()) {
        throw new AgentError('destructive_confirmation_mismatch', 'expectedProjectName 与当前部署目标名称不一致');
      }
      return createGrantedOperation({
        toolName,
        client: normalizedClient,
        workspacePath: workspace.workspacePath,
        riskLevel: 'destructive',
        executionScope: configScope,
        idempotencyKey: args.idempotencyKey,
        payload: { targetId: Number(target.id), projectName: String(target.projectName || ''), identityHash: getTargetIdentityHash(target) },
        approvalSummary: {
          title: '删除部署目标',
          warning: '该操作不可撤销，将删除目标配置、发布历史、任务记录和 OpenAPI 产物索引',
          targetId: Number(target.id),
          projectName: target.projectName,
          server: `${target.serverName || ''} ${target.serverHost || ''}`.trim(),
          environment: target.envName,
          executionScope: configScope,
        },
      });
    }
    if (toolName === 'yuyan_delete_deploy_server') {
      if (settings.role !== 'admin') throw new AgentError('admin_required', '当前账号无权删除部署服务器');
      const { server, configScope } = await getConfiguredServer(args.serverId);
      if (String(args.expectedServerName || '').trim() !== String(server.name || '').trim()) {
        throw new AgentError('destructive_confirmation_mismatch', 'expectedServerName 与当前服务器名称不一致');
      }
      const { data: targets } = await callYuyanApi(`/deploy-api/targets?serverId=${Number(server.id)}`, { scope: 'server' });
      const referencingTargets = (Array.isArray(targets) ? targets : []).filter((item) => Number(item.serverId) === Number(server.id));
      if (referencingTargets.length) {
        throw new AgentError('server_in_use', `服务器仍被 ${referencingTargets.length} 个部署目标引用，请先逐个删除目标`);
      }
      return createGrantedOperation({
        toolName,
        client: normalizedClient,
        workspacePath: workspace.workspacePath,
        riskLevel: 'destructive',
        executionScope: configScope,
        idempotencyKey: args.idempotencyKey,
        payload: { serverId: Number(server.id), serverName: String(server.name || ''), identityHash: getServerIdentityHash(server) },
        approvalSummary: {
          title: '删除空闲部署服务器',
          warning: '该操作不可撤销；雨燕已确认当前没有部署目标引用该服务器',
          serverId: Number(server.id),
          serverName: server.name,
          host: server.host,
          executionScope: configScope,
        },
      });
    }
    throw new AgentError('tool_not_found', `雨燕未注册工具：${toolName}`);
  });
}

/** UI 获取控制平面快照。 */
export function getAgentControlPlaneSnapshot(query = {}) {
  const offset = Math.max(0, Number(query.offset || 0));
  const limit = Math.min(100, Math.max(1, Number(query.limit || 50)));
  return {
    approvalPolicy: getAgentApprovalPolicy(),
    operationRetentionPolicy: getAgentOperationRetentionPolicy(),
    operations: listAgentOperations({ status: VALID_OPERATION_STATUSES.has(query.status) ? query.status : '', limit, offset }),
    grants: listProjectGrants({ limit: 100, offset: 0 }),
    audit: listAgentAudit({ limit: 50, offset: 0 }),
    auditChain: verifyAgentAuditChain(),
  };
}

/** UI 更新已结束任务的本机保留策略。 */
export function setAgentOperationRetentionPolicy(retentionDays, changedBy = 'local-user') {
  const result = updateAgentOperationRetentionPolicy({ retentionDays });
  appendAgentAudit({
    action: 'operation_retention_updated',
    changedBy: String(changedBy).slice(0, 100),
    retentionDays: result.retentionDays,
    deletedCount: result.deletedCount,
  });
  return result;
}

/** UI 删除一条已结束任务记录，进行中任务必须先取消或等待结束。 */
export function removeAgentOperationRecord(operationId, changedBy = 'local-user') {
  const result = deleteAgentOperationRecord(operationId);
  if (result.reason === 'not_found') throw new AgentError('operation_not_found', '任务记录不存在或已被清理');
  if (result.reason === 'active') throw new AgentError('operation_active', '待审批或执行中的任务不能删除，请先取消或等待任务结束');
  appendAgentAudit({
    action: 'operation_record_deleted',
    changedBy: String(changedBy).slice(0, 100),
    operationId: String(operationId),
  });
  return result;
}

/** UI 清空全部已结束任务，安全审计链和活动任务保持不变。 */
export function clearCompletedAgentOperationHistory(changedBy = 'local-user') {
  const result = clearCompletedAgentOperationRecords();
  if (result.deletedCount > 0) {
    appendAgentAudit({
      action: 'completed_operation_records_cleared',
      changedBy: String(changedBy).slice(0, 100),
      deletedCount: result.deletedCount,
    });
  }
  return result;
}

/** UI 更新审批策略并写入审计。 */
export function setAgentApprovalPolicy(patch = {}, changedBy = 'local-user') {
  if (typeof patch.autoApproveGrantedProjects !== 'boolean') {
    throw new AgentError('approval_policy_invalid', 'autoApproveGrantedProjects 必须是布尔值');
  }
  const policy = updateAgentApprovalPolicy(patch);
  appendAgentAudit({ action: 'approval_policy_updated', changedBy: String(changedBy).slice(0, 100), policy });
  return policy;
}

/** UI 撤销项目授权并写入审计。 */
export function revokeAgentProjectGrant(id) {
  const result = revokeProjectGrant(id);
  appendAgentAudit({ action: 'project_grant_revoked', grantId: id, result });
  return result;
}
