/**
 * MCP Sidecar 打包所需的外部依赖清单。
 * @description 这些包必须存在于根 package.json，并由 scripts/bundle-mcp.mjs 打进 mcp/dist/index.js。
 */
export const mcpProductionDependencies = {
  '@modelcontextprotocol/sdk': '1.29.0',
  zod: '3.25.76',
};
