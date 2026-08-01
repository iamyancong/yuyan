/** 雨燕本地 stdio MCP Server 入口。 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerYuyanTools } from './tool-registry.js';

/** 解析由客户端安装器传入的客户端标识。 */
function resolveClient(): string {
  const index = process.argv.indexOf('--client');
  const client = index >= 0 ? process.argv[index + 1] : process.env.YUYAN_MCP_CLIENT;
  return ['codex', 'cursor', 'antigravity', 'generic'].includes(String(client)) ? String(client) : 'generic';
}

const server = new McpServer(
  { name: 'yuyan-mcp-server', version: '1.0.0' },
  {
    instructions: [
      '先调用 yuyan_inspect_workspace 识别并授权当前项目。',
      '配置必须先调用 yuyan_plan_project_config，再使用 planId 调用写入工具。',
      '不得向用户索取或向工具传递 GitLab Token、SSH 密码、私钥、Nacos 凭据或雨燕端口。',
      '已授权项目的普通写操作默认按雨燕策略自动执行；删除等 destructive 工具始终等待雨燕人工审批，不得绕过或改用任意 shell 命令。',
      '长任务收到 operation 后使用 yuyan_get_operation 轮询，只有 succeeded 才能声称完成；最终必须依据 executionReport 明确说明实际动作、对象、执行位置和验证结果。',
      '项目授权只允许操作与当前 Git 仓库匹配的部署目标，不得借用一个授权项目操作其他项目。',
    ].join('\n'),
  }
);

registerYuyanTools(server, resolveClient());

try {
  await server.connect(new StdioServerTransport());
  console.error('[yuyan-mcp] yuyan-mcp-server 已通过 stdio 启动');
} catch (error) {
  console.error(`[yuyan-mcp] 启动失败：${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
}
