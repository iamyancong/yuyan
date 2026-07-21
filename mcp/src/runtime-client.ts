/**
 * 雨燕运行时发现与 Agent Gateway 客户端。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** 雨燕运行时描述文件。 */
export interface YuyanRuntimeDescriptor {
  schemaVersion: 1;
  appVersion: string;
  pid: number;
  port: number;
  sessionToken: string;
  startedAt: string;
}

/** Gateway 返回的稳定错误。 */
export class YuyanGatewayError extends Error {
  code: string;
  retryable: boolean;
  details?: Record<string, unknown>;

  /** 创建 Gateway 错误。 */
  constructor(error: { code?: string; message?: string; retryable?: boolean; details?: Record<string, unknown> }) {
    super(error.message || '雨燕 Agent Gateway 调用失败');
    this.name = 'YuyanGatewayError';
    this.code = error.code || 'gateway_error';
    this.retryable = Boolean(error.retryable);
    this.details = error.details;
  }
}

/** 推导各平台默认运行时描述文件路径。 */
export function getRuntimeDescriptorCandidates(): string[] {
  const configured = String(process.env.YUYAN_RUNTIME_DESCRIPTOR || '').trim();
  const candidates = configured ? [configured] : [];
  if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'cn.yuyan.ops', 'agent-runtime.json'));
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    candidates.push(path.join(appData, 'cn.yuyan.ops', 'agent-runtime.json'));
  } else {
    const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    candidates.push(path.join(dataHome, 'cn.yuyan.ops', 'agent-runtime.json'));
  }
  return [...new Set(candidates)];
}

/** 读取并校验描述文件基础字段。 */
async function readDescriptor(filePath: string): Promise<YuyanRuntimeDescriptor | null> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, 'utf8')) as Partial<YuyanRuntimeDescriptor>;
    if (value.schemaVersion !== 1 || !value.port || !value.pid || !value.sessionToken || !value.startedAt) return null;
    return value as YuyanRuntimeDescriptor;
  } catch {
    return null;
  }
}

/** 探测描述文件对应的 Gateway 是否仍然有效。 */
async function probeDescriptor(descriptor: YuyanRuntimeDescriptor): Promise<boolean> {
  try {
    process.kill(descriptor.pid, 0);
    const response = await fetch(`http://127.0.0.1:${descriptor.port}/agent-api/v1/tools/yuyan_get_status`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${descriptor.sessionToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ client: 'generic', arguments: {} }),
      signal: AbortSignal.timeout(1200),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** 查找当前有效运行时。 */
async function findRuntime(): Promise<YuyanRuntimeDescriptor | null> {
  for (const candidate of getRuntimeDescriptorCandidates()) {
    const descriptor = await readDescriptor(candidate);
    if (descriptor && await probeDescriptor(descriptor)) return descriptor;
  }
  return null;
}

/** 启动或聚焦雨燕桌面端。 */
export function focusYuyanApp(): void {
  const executablePath = String(process.env.YUYAN_APP_EXECUTABLE || '').trim();
  if (!executablePath || !path.isAbsolute(executablePath)) return;
  try {
    const child = spawn(executablePath, [], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (error) {
    console.error(`[yuyan-mcp] 无法启动雨燕桌面端：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 自动启动桌面端并等待 Agent Gateway 就绪。 */
export async function ensureYuyanRuntime(timeoutMs = 20_000): Promise<YuyanRuntimeDescriptor> {
  const existing = await findRuntime();
  if (existing) return existing;
  focusYuyanApp();
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const descriptor = await findRuntime();
    if (descriptor) return descriptor;
  }
  throw new YuyanGatewayError({
    code: 'app_start_timeout',
    message: '雨燕未能在 20 秒内启动 Agent Gateway，请打开雨燕查看本地服务诊断',
    retryable: true,
  });
}

/** 调用雨燕 Agent 工具网关。 */
export async function callYuyanTool(toolName: string, client: string, args: Record<string, unknown>): Promise<unknown> {
  let descriptor = await ensureYuyanRuntime();
  const request = async () => fetch(`http://127.0.0.1:${descriptor.port}/agent-api/v1/tools/${encodeURIComponent(toolName)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${descriptor.sessionToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ client, arguments: args }),
    signal: AbortSignal.timeout(30_000),
  });
  let response = await request();
  if (response.status === 401) {
    descriptor = await ensureYuyanRuntime();
    response = await request();
  }
  const body = await response.json().catch(() => null) as { success?: boolean; data?: unknown; error?: ConstructorParameters<typeof YuyanGatewayError>[0] } | null;
  if (!response.ok || !body?.success) throw new YuyanGatewayError(body?.error || { message: `Agent Gateway 返回 HTTP ${response.status}` });
  const data = body.data as { authorizationRequired?: boolean; status?: string } | undefined;
  if (data?.authorizationRequired || data?.status === 'pending_approval') focusYuyanApp();
  return body.data;
}
