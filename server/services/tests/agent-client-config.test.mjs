import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test, { after } from 'node:test';

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyan-client-config-'));
const executablePath = path.join(testHome, '雨燕 App', '雨燕');
fs.mkdirSync(path.dirname(executablePath), { recursive: true });
fs.writeFileSync(executablePath, 'test');
process.env.YUYAN_AGENT_CONFIG_HOME = testHome;
process.env.YUYAN_AGENT_LAUNCHER_DIR = path.join(testHome, 'agent-launcher');
process.env.YUYAN_APP_EXECUTABLE = executablePath;

const installer = await import('../agent-client-config-service.mjs');

after(() => fs.rmSync(testHome, { recursive: true, force: true }));

test('三客户端安装器保留已有 MCP、创建备份并可精准卸载', async () => {
  const codexPath = path.join(testHome, '.codex', 'config.toml');
  const cursorPath = path.join(testHome, '.cursor', 'mcp.json');
  const antigravityPath = path.join(testHome, '.gemini', 'config', 'mcp_config.json');
  fs.mkdirSync(path.dirname(codexPath), { recursive: true });
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.mkdirSync(path.dirname(antigravityPath), { recursive: true });
  fs.writeFileSync(codexPath, '[mcp_servers.existing]\ncommand = "existing"\n');
  fs.writeFileSync(cursorPath, JSON.stringify({ mcpServers: { existing: { command: 'existing' } }, theme: 'dark' }));
  fs.writeFileSync(antigravityPath, JSON.stringify({ mcpServers: { existing: { command: 'existing' } }, custom: true }));

  for (const client of ['codex', 'cursor', 'antigravity']) {
    const result = await installer.installAgentClient(client);
    assert.equal(result.installed, true);
    assert.ok(result.backupPath);
    assert.equal(fs.existsSync(result.backupPath), true);
  }

  const codex = fs.readFileSync(codexPath, 'utf8');
  assert.match(codex, /\[mcp_servers\.existing\]/);
  assert.match(codex, /\[mcp_servers\.yuyan-mcp-server\]/);
  const cursor = JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
  assert.equal(cursor.theme, 'dark');
  assert.equal(cursor.mcpServers.existing.command, 'existing');
  assert.equal(cursor.mcpServers['yuyan-mcp-server'].command, path.join(testHome, 'agent-launcher', 'yuyan-mcp'));
  assert.equal(cursor.mcpServers['yuyan-mcp-server'].args[0], '--mcp');
  const antigravity = JSON.parse(fs.readFileSync(antigravityPath, 'utf8'));
  assert.equal(antigravity.custom, true);
  assert.equal(antigravity.mcpServers.existing.command, 'existing');

  const statuses = await installer.getAgentClientStatuses();
  assert.ok(statuses.every((item) => item.installed && !item.needsRepair));

  const generic = await installer.getGenericAgentClientConfig();
  assert.equal(generic.config.mcpServers['yuyan-mcp-server'].command, path.join(testHome, 'agent-launcher', 'yuyan-mcp'));
  assert.equal(generic.launcher.sameMachineOnly, true);
  assert.doesNotMatch(JSON.stringify(generic.config), /src-tauri|target\/debug/);
  assert.match(fs.readFileSync(generic.launcher.path, 'utf8'), /未找到可执行文件/);
  assert.equal(fs.statSync(generic.launcher.path).mode & 0o777, 0o700);
  if (process.platform !== 'win32') execFileSync('sh', ['-n', generic.launcher.path]);

  for (const client of ['codex', 'cursor', 'antigravity']) await installer.uninstallAgentClient(client);
  assert.doesNotMatch(fs.readFileSync(codexPath, 'utf8'), /yuyan-mcp-server/);
  assert.equal(JSON.parse(fs.readFileSync(cursorPath, 'utf8')).mcpServers.existing.command, 'existing');
  assert.equal(JSON.parse(fs.readFileSync(antigravityPath, 'utf8')).mcpServers.existing.command, 'existing');
});

test('旧版直接可执行文件配置会被标记为需要修复', async () => {
  const cursorPath = path.join(testHome, '.cursor', 'mcp.json');
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(cursorPath, JSON.stringify({
    mcpServers: { 'yuyan-mcp-server': { command: executablePath, args: ['--mcp', '--client', 'cursor'] } },
  }));
  const cursorStatus = (await installer.getAgentClientStatuses()).find((item) => item.client === 'cursor');
  assert.equal(cursorStatus.installed, true);
  assert.equal(cursorStatus.needsRepair, true);
});

test('当前可执行文件缺失时拒绝生成失效配置', async () => {
  const movedPath = `${executablePath}.moved`;
  fs.renameSync(executablePath, movedPath);
  try {
    await assert.rejects(() => installer.getGenericAgentClientConfig(), (error) => error.code === 'executable_missing');
  } finally {
    fs.renameSync(movedPath, executablePath);
  }
});

test('损坏 JSON 配置时拒绝覆盖原文件', async () => {
  const cursorPath = path.join(testHome, '.cursor', 'mcp.json');
  fs.writeFileSync(cursorPath, '{ invalid json');
  await assert.rejects(() => installer.installAgentClient('cursor'), (error) => error.code === 'client_config_invalid');
  assert.equal(fs.readFileSync(cursorPath, 'utf8'), '{ invalid json');
});
