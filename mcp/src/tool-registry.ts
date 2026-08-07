/**
 * 雨燕 MCP 工具注册表。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { callYuyanTool, YuyanGatewayError } from './runtime-client.js';

const workspacePath = z.string().min(1).describe('当前项目内的任意绝对路径；雨燕会规范化为真实 Git 根目录');
const cursor = z.string().min(1).optional().describe('上一页返回的 nextCursor');
const limit = z.number().int().min(1).max(100).default(20).describe('单页最多返回 100 条');
const responseLength = z.enum(['short', 'medium', 'long']).default('medium').describe('建议的文本响应长度');
const idempotencyKey = z.string().min(8).max(128).describe('调用方为本次写操作生成的稳定幂等键，重试时必须复用');
const targetId = z.number().int().positive().describe('雨燕部署目标 ID');

/** MCP 工具定义。 */
export const YUYAN_TOOL_DEFINITIONS = [
  {
    name: 'yuyan_get_status',
    description: '检查雨燕桌面端、Agent Gateway、中央/本地执行上下文、待审批数量和审计链状态。无需项目授权。',
    schema: z.object({}).strict(),
    readOnly: true,
  },
  {
    name: 'yuyan_inspect_workspace',
    description: '识别真实 Git 根目录、远程仓库、项目类型、包管理器、分支、Commit 和现有授权。首次访问会在雨燕中创建项目授权审批。',
    schema: z.object({ workspacePath }).strict(),
    readOnly: true,
  },
  {
    name: 'yuyan_search_projects',
    description: '搜索当前 MCP 客户端已获授权的雨燕项目，不扫描整个磁盘。支持游标分页。',
    schema: z.object({ keyword: z.string().max(200).optional(), cursor, limit, responseLength }).strict(),
    readOnly: true,
  },
  {
    name: 'yuyan_list_deploy_servers',
    description: '列出雨燕中已配置的部署服务器。只返回脱敏信息和实际配置读取位置。',
    schema: z.object({ workspacePath, cursor, limit, responseLength }).strict(),
    readOnly: true,
  },
  {
    name: 'yuyan_list_deploy_targets',
    description: '列出与项目或筛选条件匹配的部署目标，返回脱敏配置与游标。',
    schema: z.object({ workspacePath, keyword: z.string().max(200).optional(), projectType: z.enum(['frontend', 'backend']).optional(), cursor, limit, responseLength }).strict(),
    readOnly: true,
  },
  {
    name: 'yuyan_get_deploy_history',
    description: '查询脱敏发布历史。不会返回 GitLab Token、SSH 凭据或私钥。',
    schema: z.object({ workspacePath, targetId: z.number().int().positive().optional(), cursor, limit, responseLength }).strict(),
    readOnly: true,
  },
  {
    name: 'yuyan_plan_project_config',
    description: '解析 package.json、锁文件或 Maven POM，生成部署配置差异和 15 分钟有效的 planId；此工具不写配置。',
    schema: z.object({
      workspacePath,
      projectId: z.number().int().positive().optional(),
      projectName: z.string().min(1).max(120).optional(),
      projectPath: z.string().min(1).max(300).optional(),
      repositoryUrl: z.string().max(500).optional(),
      description: z.string().max(500).optional(),
      branch: z.string().max(200).optional(),
      envName: z.string().max(100).optional(),
      serverId: z.number().int().positive().optional(),
      nginxInstanceId: z.number().int().positive().optional(),
      target: z.object({
        deployRoot: z.string().max(500).optional(),
        nginxConfPath: z.string().max(500).optional(),
        nginxSiteManaged: z.boolean().optional(),
        listenPort: z.number().int().min(1).max(65535).optional(),
        serverName: z.string().max(300).optional(),
        enableNginxTest: z.boolean().optional(),
        enableNginxReload: z.boolean().optional(),
        installCommand: z.string().max(2000).optional(),
        buildCommand: z.string().max(2000).optional(),
        artifactDir: z.string().max(500).optional(),
        visitUrl: z.string().max(500).optional(),
        serverPort: z.number().int().min(1).max(65535).optional(),
        remark: z.string().max(500).optional(),
      }).strict().optional(),
    }).strict(),
    readOnly: true,
  },
  {
    name: 'yuyan_apply_project_config',
    description: '使用短期 planId 应用项目配置。已授权项目默认自动执行；关闭自动执行时等待审批，计划哈希或 Commit 变化会失效。',
    schema: z.object({ workspacePath, planId: z.string().uuid(), idempotencyKey }).strict(),
    readOnly: false,
  },
  {
    name: 'yuyan_create_microapp',
    description: '复用雨燕脚手架创建微应用，可选创建 GitLab 仓库并推送。已授权项目按雨燕审批策略执行，凭据只从雨燕读取。',
    schema: z.object({
      workspacePath,
      idempotencyKey,
      appName: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
      appNameZh: z.string().min(1).max(100),
      description: z.string().max(500).optional(),
      port: z.number().int().min(1024).max(65535).default(8081),
      activeRule: z.string().max(200).default(''),
      apiBase: z.string().max(200).default('/api'),
      proxyTarget: z.string().max(500).default('http://localhost:3000'),
      openapiUrl: z.string().max(500).optional(),
      createRepo: z.boolean().default(false),
      namespaceId: z.string().max(100).optional(),
      visibility: z.enum(['private', 'internal', 'public']).default('private'),
    }).strict(),
    readOnly: false,
  },
  {
    name: 'yuyan_preflight_deploy_target',
    description: '发布前检查目标、分支、Commit、工作区状态、服务器和实际执行位置，不产生外部副作用。',
    schema: z.object({ workspacePath, targetId, branch: z.string().max(200).optional() }).strict(),
    readOnly: true,
  },
  {
    name: 'yuyan_deploy_target',
    description: '发布当前授权项目的指定目标。返回后台 operation，Commit 或项目授权变化会使任务失效。',
    schema: z.object({ workspacePath, targetId, branch: z.string().max(200).optional(), idempotencyKey }).strict(),
    readOnly: false,
  },
  {
    name: 'yuyan_rollback_deployment',
    description: '回滚当前授权项目的指定发布记录，按雨燕审批策略执行并返回明确执行回执。',
    schema: z.object({ workspacePath, recordId: z.number().int().positive(), idempotencyKey }).strict(),
    readOnly: false,
  },
  {
    name: 'yuyan_get_service_status',
    description: '查询后端服务受控运行状态、健康信息和实际执行位置。',
    schema: z.object({ workspacePath, targetId }).strict(),
    readOnly: true,
  },
  {
    name: 'yuyan_read_service_logs',
    description: '读取后端服务最近日志，服务端会脱敏凭据；最多返回 1000 行。',
    schema: z.object({ workspacePath, targetId, lines: z.number().int().min(10).max(1000).default(200), responseLength }).strict(),
    readOnly: true,
  },
  {
    name: 'yuyan_control_service',
    description: '申请 start、stop 或 restart 后端服务。仅使用雨燕预配置的受控服务命令，不接受任意 SSH 命令。',
    schema: z.object({ workspacePath, targetId, action: z.enum(['start', 'stop', 'restart']), idempotencyKey }).strict(),
    readOnly: false,
  },
  {
    name: 'yuyan_generate_openapi',
    description: '复用雨燕 JDK 检测、本地构建与缓存生成 OpenAPI，按雨燕审批策略执行。',
    schema: z.object({ workspacePath, targetId, branch: z.string().max(200).optional(), force: z.boolean().default(false), idempotencyKey }).strict(),
    readOnly: false,
  },
  {
    name: 'yuyan_delete_deploy_target',
    description: '删除当前授权项目的雨燕部署目标及其关联历史和产物索引。此高危操作始终需要在雨燕中人工审批，自动执行开关不能绕过。',
    schema: z.object({
      workspacePath,
      targetId,
      expectedProjectName: z.string().trim().min(1).max(120).describe('从目标查询结果原样传回的项目名称，用于防止 ID 指向变化'),
      idempotencyKey,
    }).strict(),
    readOnly: false,
    destructive: true,
  },
  {
    name: 'yuyan_delete_deploy_server',
    description: '删除没有任何部署目标引用的空闲服务器。必须原样传回服务器名称且始终人工审批；不会隐式级联删除目标。',
    schema: z.object({
      workspacePath,
      serverId: z.number().int().positive().describe('雨燕部署服务器 ID'),
      expectedServerName: z.string().trim().min(1).max(120).describe('从服务器查询结果原样传回的名称，用于防止 ID 指向变化'),
      idempotencyKey,
    }).strict(),
    readOnly: false,
    destructive: true,
  },
  {
    name: 'yuyan_get_operation',
    description: '查询审批、排队、执行进度、阶段日志、结果或稳定错误代码。Sidecar 重启后仍可查询。',
    schema: z.object({ operationId: z.string().uuid(), responseLength }).strict(),
    readOnly: true,
  },
  {
    name: 'yuyan_cancel_operation',
    description: '取消待审批、排队中或仍处于可安全停止阶段的任务。不会强行中断已进入不可逆阶段的远程动作。',
    schema: z.object({ operationId: z.string().uuid(), idempotencyKey }).strict(),
    readOnly: false,
  },
] as const;

/** 生成兼容文本与 structuredContent。 */
function createToolResult(data: unknown) {
  const structuredContent = { ok: true, data };
  const operation = data && typeof data === 'object' ? data as Record<string, unknown> : null;
  const result = operation?.result && typeof operation.result === 'object' ? operation.result as Record<string, unknown> : null;
  const report = result?.executionReport && typeof result.executionReport === 'object'
    ? result.executionReport as Record<string, unknown>
    : null;
  const text = report?.summary
    ? `雨燕执行完成：${String(report.summary)}\n执行回执：${JSON.stringify(report, null, 2)}`
    : operation?.status === 'pending_approval'
      ? `雨燕已创建高风险待审批任务 ${String(operation.id || '')}，尚未执行。请等待用户在雨燕中确认。`
      : ['queued', 'running'].includes(String(operation?.status || ''))
        ? `雨燕已${operation?.approvedBy === 'policy:trusted-project' ? '按已授权项目策略自动批准并' : ''}提交后台任务 ${String(operation?.id || '')}，当前状态：${String(operation?.status)}。请用 yuyan_get_operation 轮询到终态后，再向用户说明执行结果。`
        : JSON.stringify(structuredContent, null, 2);
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent,
  };
}

/** 生成可操作的 MCP 错误结果。 */
function createToolError(error: unknown) {
  const source = error instanceof YuyanGatewayError ? error : new YuyanGatewayError({ message: error instanceof Error ? error.message : String(error) });
  const structuredContent = { ok: false, error: { code: source.code, message: source.message, retryable: source.retryable, details: source.details } };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

/** 注册全部雨燕 MCP 工具。 */
export function registerYuyanTools(server: McpServer, client: string): void {
  for (const definition of YUYAN_TOOL_DEFINITIONS) {
    server.registerTool(definition.name, {
      title: definition.name,
      description: definition.description,
      inputSchema: definition.schema,
      annotations: {
        readOnlyHint: definition.readOnly,
        destructiveHint: 'destructive' in definition && definition.destructive === true,
        idempotentHint: !definition.readOnly,
        openWorldHint: !definition.readOnly,
      },
    }, async (args: Record<string, unknown>) => {
      try {
        return createToolResult(await callYuyanTool(definition.name, client, args as Record<string, unknown>));
      } catch (error) {
        return createToolError(error);
      }
    });
  }
}
