import crypto from 'node:crypto';

/**
 * Agent Gateway HTTP 控制器。
 */

import {
  approveAgentOperation,
  abortAgentOperationsForIdentity,
  cancelAgentOperation,
  clearCompletedAgentOperationHistory,
  createDesktopBackendDeployOperation,
  createDesktopOpenApiOperation,
  executeAgentTool,
  getAgentControlPlaneSnapshot,
  getDesktopOpenApiArtifact,
  readDesktopOpenApiArtifact,
  rejectAgentOperation,
  removeAgentOperationRecord,
  revokeAgentProjectGrant,
  setAgentApprovalPolicy,
  setAgentOperationRetentionPolicy,
  serializeAgentError,
} from '../services/agent-command-service.mjs';
import { expireAgentOperationsForIdentity, getAgentOperation, listPendingAgentApprovals } from '../services/agent-store.mjs';
import { getAgentRuntimeSettings, updateAgentRuntimeSettings } from '../services/agent-runtime-service.mjs';
import { getAgentEventRevision, subscribeAgentChanges } from '../services/agent-event-service.mjs';
import {
  getAgentClientStatuses,
  getGenericAgentClientConfig,
  installAgentClient,
  uninstallAgentClient,
} from '../services/agent-client-config-service.mjs';

/** 发送统一 Agent 错误响应。 */
function sendAgentError(res, error, fallbackStatus = 400) {
  const serialized = serializeAgentError(error);
  const status = serialized.code === 'operation_not_found' ? 404
    : serialized.code === 'authorization_failed' ? 401
      : fallbackStatus;
  res.status(status).json({ success: false, error: serialized });
}

/** 调用 MCP 工具对应的受控命令。 */
export async function handleAgentToolCall(req, res) {
  try {
    const data = await executeAgentTool(String(req.params.toolName || ''), req.body?.client, req.body?.arguments || {});
    res.json({ success: true, data });
  } catch (error) {
    sendAgentError(res, error);
  }
}

/** 获取 AI 集成界面快照。 */
export async function handleGetAgentSnapshot(req, res) {
  try {
    res.json({ success: true, data: getAgentControlPlaneSnapshot(req.query || {}) });
  } catch (error) {
    sendAgentError(res, error, 500);
  }
}

/** 获取当前身份待审批任务的轻量投影。 */
export function handleListPendingAgentApprovals(req, res) {
  try {
    res.json({ success: true, data: listPendingAgentApprovals(req.query?.limit) });
  } catch (error) {
    sendAgentError(res, error, 500);
  }
}

/** 建立 Agent 控制平面变更 SSE。 */
export function handleAgentEvents(req, res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  /** 写入一个不含业务数据的 SSE 事件。 */
  const writeEvent = (eventName, event) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`id: ${event.revision}\nevent: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  const unsubscribe = subscribeAgentChanges((event) => writeEvent('change', event));
  writeEvent('ready', { revision: getAgentEventRevision(), domains: [] });
  const heartbeatTimer = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': heartbeat\n\n');
  }, 30_000);
  heartbeatTimer.unref?.();

  let cleaned = false;
  /** 清理当前 SSE 连接资源。 */
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeatTimer);
    unsubscribe();
  };
  req.once('aborted', cleanup);
  res.once('close', cleanup);
  res.once('finish', cleanup);
}

/** 获取单个任务。 */
export async function handleGetAgentOperation(req, res) {
  try {
    const operation = getAgentOperation(String(req.params.id || ''));
    if (!operation) return sendAgentError(res, Object.assign(new Error('操作不存在'), { code: 'operation_not_found' }), 404);
    res.json({ success: true, data: operation });
  } catch (error) {
    sendAgentError(res, error);
  }
}

/** 批准任务并交给后台执行。 */
export async function handleApproveAgentOperation(req, res) {
  try {
    res.json({ success: true, data: approveAgentOperation(String(req.params.id || ''), String(req.body?.approvedBy || 'local-user')) });
  } catch (error) {
    sendAgentError(res, error);
  }
}

/** 拒绝任务。 */
export async function handleRejectAgentOperation(req, res) {
  try {
    res.json({ success: true, data: rejectAgentOperation(String(req.params.id || ''), String(req.body?.approvedBy || 'local-user')) });
  } catch (error) {
    sendAgentError(res, error);
  }
}

/** 取消任务。 */
export async function handleCancelAgentOperation(req, res) {
  try {
    res.json({ success: true, data: await cancelAgentOperation(String(req.params.id || '')) });
  } catch (error) {
    sendAgentError(res, error);
  }
}

/** 删除一条已结束任务记录。 */
export function handleDeleteAgentOperation(req, res) {
  try {
    res.json({
      success: true,
      data: removeAgentOperationRecord(String(req.params.id || ''), String(req.body?.changedBy || '雨燕桌面端用户')),
    });
  } catch (error) {
    sendAgentError(res, error);
  }
}

/** 清空当前身份的全部已结束任务。 */
export function handleClearCompletedAgentOperations(req, res) {
  try {
    res.json({
      success: true,
      data: clearCompletedAgentOperationHistory(String(req.body?.changedBy || '雨燕桌面端用户')),
    });
  } catch (error) {
    sendAgentError(res, error);
  }
}

/** 从雨燕部署页启动后端设备构建与中央部署。 */
export async function handleDesktopBackendDeploy(req, res) {
  try {
    const idempotencyKey = String(req.body?.idempotencyKey || `desktop-${crypto.randomUUID()}`);
    res.json({
      success: true,
      data: await createDesktopBackendDeployOperation(Number(req.body?.targetId), String(req.body?.branch || ''), idempotencyKey),
    });
  } catch (error) {
    sendAgentError(res, error);
  }
}

/** 从雨燕 OpenAPI 抽屉启动当前设备生成任务。 */
export async function handleDesktopOpenApiGenerate(req, res) {
  try {
    const idempotencyKey = String(req.body?.idempotencyKey || `desktop-openapi-${crypto.randomUUID()}`);
    res.json({
      success: true,
      data: await createDesktopOpenApiOperation(Number(req.body?.targetId), String(req.body?.branch || ''), Boolean(req.body?.force), idempotencyKey),
    });
  } catch (error) {
    sendAgentError(res, error);
  }
}

/** 返回当前设备某目标最新 OpenAPI 元数据。 */
export function handleGetDesktopOpenApiLatest(req, res) {
  try {
    const artifact = getDesktopOpenApiArtifact(Number(req.query?.targetId), String(req.query?.branch || ''));
    if (!artifact) return sendAgentError(res, Object.assign(new Error('当前设备暂无 OpenAPI 产物'), { code: 'openapi_artifact_not_found' }), 404);
    res.json({ success: true, data: artifact });
  } catch (error) {
    sendAgentError(res, error);
  }
}

/** 返回当前设备 OpenAPI 内容。 */
export async function handleReadDesktopOpenApi(req, res) {
  try {
    res.json({ success: true, data: await readDesktopOpenApiArtifact(String(req.params.id || '')) });
  } catch (error) {
    sendAgentError(res, error, 404);
  }
}

/** 撤销项目授权。 */
export async function handleRevokeAgentGrant(req, res) {
  try {
    res.json({ success: true, data: revokeAgentProjectGrant(String(req.params.id || '')) });
  } catch (error) {
    sendAgentError(res, error);
  }
}

/** 同步雨燕当前中央 API 和内存凭据上下文。 */
export async function handleUpdateAgentSettings(req, res) {
  try {
    const previous = getAgentRuntimeSettings();
    const next = updateAgentRuntimeSettings(req.body || {});
    const identityChanged = previous.accountId && (
      previous.accountId !== next.accountId
      || previous.deviceId !== next.deviceId
      || previous.teamId !== next.teamId
    );
    if (identityChanged) {
      abortAgentOperationsForIdentity(previous);
      expireAgentOperationsForIdentity(previous, 'identity_changed');
    }
    res.json({ success: true, data: next });
  } catch (error) {
    sendAgentError(res, error);
  }
}

/** 更新已授权项目的自动执行策略。 */
export async function handleUpdateAgentApprovalPolicy(req, res) {
  try {
    res.json({
      success: true,
      data: setAgentApprovalPolicy(
        { autoApproveGrantedProjects: req.body?.autoApproveGrantedProjects },
        String(req.body?.changedBy || '雨燕桌面端用户')
      ),
    });
  } catch (error) {
    sendAgentError(res, error);
  }
}

/** 更新已结束任务的本机保留策略。 */
export function handleUpdateAgentOperationRetentionPolicy(req, res) {
  try {
    res.json({
      success: true,
      data: setAgentOperationRetentionPolicy(
        req.body?.retentionDays,
        String(req.body?.changedBy || '雨燕桌面端用户'),
      ),
    });
  } catch (error) {
    sendAgentError(res, error);
  }
}

/** 获取三客户端安装状态与通用配置。 */
export async function handleGetAgentClients(_req, res) {
  try {
    let genericConfig = null;
    let launcher = null;
    try {
      const generic = await getGenericAgentClientConfig();
      genericConfig = generic.config;
      launcher = generic.launcher;
    } catch {
      genericConfig = null;
    }
    res.json({ success: true, data: { clients: await getAgentClientStatuses(), genericConfig, launcher } });
  } catch (error) {
    sendAgentError(res, error, 500);
  }
}

/** 安装或修复客户端配置。 */
export async function handleInstallAgentClient(req, res) {
  try {
    res.json({ success: true, data: await installAgentClient(String(req.params.client || '')) });
  } catch (error) {
    sendAgentError(res, error);
  }
}

/** 卸载客户端配置。 */
export async function handleUninstallAgentClient(req, res) {
  try {
    res.json({ success: true, data: await uninstallAgentClient(String(req.params.client || '')) });
  } catch (error) {
    sendAgentError(res, error);
  }
}
