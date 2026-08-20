/**
 * MCP 客户端全局配置安装器。
 * @description 原子合并用户现有配置，修改前创建时间戳备份。
 */

import fs from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AGENT_DB_PATH, YUYAN_APP_EXECUTABLE } from '../config/constants.mjs';
import { AgentError } from './agent-workspace-service.mjs';

const SERVER_NAME = 'yuyan-mcp-server';
const CODEX_BEGIN = '# BEGIN YUYAN MCP - managed by 雨燕';
const CODEX_END = '# END YUYAN MCP - managed by 雨燕';
/** Codex CLI 解析候选配置的最长等待时间。 */
const CODEX_VALIDATION_TIMEOUT_MS = 15_000;
const CONFIG_HOME = String(process.env.YUYAN_AGENT_CONFIG_HOME || os.homedir());
const LAUNCHER_DIR = String(process.env.YUYAN_AGENT_LAUNCHER_DIR || path.join(path.dirname(AGENT_DB_PATH), 'mcp-launcher'));
const execFile = promisify(execFileCallback);

/** 客户端配置元数据。 */
const CLIENTS = {
  codex: { label: 'Codex', filePath: path.join(CONFIG_HOME, '.codex', 'config.toml'), format: 'toml' },
  cursor: { label: 'Cursor', filePath: path.join(CONFIG_HOME, '.cursor', 'mcp.json'), format: 'json' },
  antigravity: { label: 'Antigravity', filePath: path.join(CONFIG_HOME, '.gemini', 'config', 'mcp_config.json'), format: 'json' },
};

/** TOML 双引号转义。 */
const quoteToml = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** 获取并校验雨燕可执行文件路径。 */
async function getExecutablePath() {
  if (!YUYAN_APP_EXECUTABLE || !path.isAbsolute(YUYAN_APP_EXECUTABLE)) {
    throw new AgentError('executable_unavailable', '当前雨燕可执行文件路径不可用，请从已安装桌面端重试');
  }
  await fs.access(YUYAN_APP_EXECUTABLE).catch(() => {
    throw new AgentError('executable_missing', '当前雨燕可执行文件已不存在，请重新启动或安装雨燕后修复 MCP');
  });
  return YUYAN_APP_EXECUTABLE;
}

/** 读取文本，不存在时返回空文本。 */
const readText = async (filePath) => fs.readFile(filePath, 'utf8').catch((error) => {
  if (error?.code === 'ENOENT') return '';
  throw error;
});

/** 原子写入配置并保留备份。 */
async function atomicWrite(filePath, content, previousContent) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const currentContent = await readText(filePath);
  if (currentContent !== previousContent) {
    throw new AgentError('client_config_changed', `${filePath} 已被其他程序修改，请刷新状态后重试`);
  }
  let backupPath = '';
  if (previousContent) {
    backupPath = `${filePath}.yuyan-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fs.writeFile(backupPath, previousContent, { mode: 0o600 });
  }
  const tempPath = `${filePath}.yuyan-tmp-${process.pid}`;
  await fs.writeFile(tempPath, content, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
  return backupPath;
}

/** 原子刷新稳定启动器，不为内部派生文件生成历史备份。 */
async function atomicWriteLauncher(filePath, content) {
  const previous = await readText(filePath);
  if (previous === content) {
    await fs.chmod(filePath, 0o700).catch(() => undefined);
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await fs.writeFile(tempPath, content, { mode: 0o700 });
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o700).catch(() => undefined);
}

/** POSIX shell 单引号安全转义。 */
const quoteShell = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;

/** PowerShell 单引号安全转义。 */
const quotePowerShell = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** 获取当前平台可能存在的雨燕可执行文件候选。 */
function getExecutableCandidates(executablePath) {
  const candidates = [executablePath];
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/雨燕.app/Contents/MacOS/yuyan-app',
      '/Applications/雨燕.app/Contents/MacOS/雨燕',
      path.join(CONFIG_HOME, 'Applications', '雨燕.app', 'Contents', 'MacOS', 'yuyan-app'),
      path.join(CONFIG_HOME, 'Applications', '雨燕.app', 'Contents', 'MacOS', '雨燕')
    );
  } else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(CONFIG_HOME, 'AppData', 'Local');
    candidates.push(
      path.join(localAppData, '雨燕', '雨燕.exe'),
      path.join(localAppData, '雨燕', 'yuyan-app.exe'),
      path.join(localAppData, 'Programs', '雨燕', '雨燕.exe'),
      path.join(localAppData, 'Programs', '雨燕', 'yuyan-app.exe')
    );
  } else {
    candidates.push('/usr/local/bin/yuyan-app', '/usr/bin/yuyan-app', '/opt/yuyan/yuyan-app');
  }
  return [...new Set(candidates.filter((item) => path.isAbsolute(item)))];
}

/** 创建并刷新应用数据目录中的稳定 MCP 启动器。 */
async function ensureStableLauncher() {
  const executablePath = await getExecutablePath();
  const candidates = getExecutableCandidates(executablePath);
  const development = /[\\/]src-tauri[\\/]target[\\/](?:debug|release)[\\/]/i.test(executablePath);
  if (process.platform === 'win32') {
    const launcherPath = path.join(LAUNCHER_DIR, 'yuyan-mcp.ps1');
    const values = candidates.map(quotePowerShell).join(', ');
    const content = `$ErrorActionPreference = 'Stop'\n$Candidates = @(${values})\nforeach ($Candidate in $Candidates) {\n  if (Test-Path -LiteralPath $Candidate -PathType Leaf) {\n    & $Candidate @args\n    exit $LASTEXITCODE\n  }\n}\n[Console]::Error.WriteLine('雨燕 MCP 启动失败：未找到可执行文件，请打开雨燕并在 AI 集成中修复客户端配置。')\nexit 127\n`;
    await atomicWriteLauncher(launcherPath, content);
    return {
      path: launcherPath,
      targetPath: executablePath,
      runtimeMode: development ? 'development' : 'installed',
      stable: true,
      command: 'powershell.exe',
      prefixArgs: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', launcherPath],
    };
  }
  const launcherPath = path.join(LAUNCHER_DIR, 'yuyan-mcp');
  const values = candidates.map((candidate) => `  ${quoteShell(candidate)}`).join(' \\\n');
  const content = `#!/bin/sh\nset -eu\nfor candidate in \\\n${values}\ndo\n  if [ -x "$candidate" ]; then\n    exec "$candidate" "$@"\n  fi\ndone\nprintf '%s\\n' '雨燕 MCP 启动失败：未找到可执行文件，请打开雨燕并在 AI 集成中修复客户端配置。' >&2\nexit 127\n`;
  await atomicWriteLauncher(launcherPath, content);
  return {
    path: launcherPath,
    targetPath: executablePath,
    runtimeMode: development ? 'development' : 'installed',
    stable: true,
    command: launcherPath,
    prefixArgs: [],
  };
}

/** 创建指定客户端的稳定启动命令。 */
function createLaunchSpec(launcher, client) {
  return {
    command: launcher.command,
    args: [...launcher.prefixArgs, '--mcp', '--client', client],
  };
}

/** 创建 Codex 托管配置块。 */
function createCodexBlock(launchSpec) {
  return `${CODEX_BEGIN}\n[mcp_servers.${SERVER_NAME}]\ncommand = ${quoteToml(launchSpec.command)}\nargs = [${launchSpec.args.map(quoteToml).join(', ')}]\nstartup_timeout_sec = 20\ntool_timeout_sec = 1800\ndefault_tools_approval_mode = "approve"\n${CODEX_END}`;
}

/** 转义正则表达式字面量。 */
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 匹配任意 TOML 表头。 */
const isTomlTableHeader = (line) => /^\s*\[\[?.+\]\]?\s*(?:#.*)?$/.test(line) && !line.includes('=');

/** 判断 TOML 表头是否属于雨燕 MCP，包括其 env/tools 子表。 */
const isCodexServerTableHeader = (line) => new RegExp(
  `^\\s*\\[\\[?\\s*mcp_servers\\s*\\.\\s*(?:${escapeRegExp(SERVER_NAME)}|"${escapeRegExp(SERVER_NAME)}"|'${escapeRegExp(SERVER_NAME)}')(?:\\s*\\..+)?\\s*\\]\\]?\\s*(?:#.*)?$`
).test(line);

/** 判断 TOML 表头是否为雨燕 MCP 根表。 */
const isCodexServerRootTableHeader = (line) => new RegExp(
  `^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${escapeRegExp(SERVER_NAME)}|"${escapeRegExp(SERVER_NAME)}"|'${escapeRegExp(SERVER_NAME)}')\\s*\\]\\s*(?:#.*)?$`
).test(line);

/** 删除雨燕托管块以及所有同名旧版 Codex MCP 表。 */
function removeCodexServerConfig(source) {
  const managedPattern = new RegExp(`${escapeRegExp(CODEX_BEGIN)}[\\s\\S]*?${escapeRegExp(CODEX_END)}\\n?`, 'g');
  const lines = source.replace(managedPattern, '').split(/\r?\n/);
  const result = [];
  let skippingServerTable = false;
  for (const line of lines) {
    if (isCodexServerTableHeader(line)) {
      skippingServerTable = true;
      continue;
    }
    if (skippingServerTable && isTomlTableHeader(line)) skippingServerTable = false;
    if (!skippingServerTable) result.push(line);
  }
  return result.join('\n').trimEnd();
}

/** 统计 Codex 配置中的雨燕 MCP 根表数量。 */
function countCodexServerTables(source) {
  return source.split(/\r?\n/).filter(isCodexServerRootTableHeader).length;
}

/** 返回本机可能存在的 Codex CLI 路径。 */
function getCodexCliCandidates() {
  const candidates = [process.env.YUYAN_CODEX_CLI_PATH, process.env.CODEX_CLI_PATH];
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      '/Applications/Codex.app/Contents/Resources/codex',
      path.join(CONFIG_HOME, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex'),
      path.join(CONFIG_HOME, 'Applications', 'Codex.app', 'Contents', 'Resources', 'codex')
    );
  } else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(CONFIG_HOME, 'AppData', 'Local');
    candidates.push(
      path.join(localAppData, 'Programs', 'ChatGPT', 'resources', 'codex.exe'),
      path.join(localAppData, 'Programs', 'Codex', 'resources', 'codex.exe')
    );
  }
  candidates.push('codex');
  return [...new Set(candidates.map((item) => String(item || '').trim()).filter(Boolean))];
}

/** 返回不包含配置原文的 Codex 校验错误摘要。 */
function summarizeCodexValidationError(error) {
  const message = String(error?.stderr || error?.message || '');
  const location = message.match(/(?:at\s+line|line)\s+\d+(?:\s*,?\s*column\s+\d+)?/i)?.[0];
  if (location) return `配置语法错误（${location}）`;
  const exitCode = typeof error?.code === 'number' ? `，退出码 ${error.code}` : '';
  return `Codex CLI 拒绝了候选配置${exitCode}`;
}

/** 使用 Codex 自身解析候选配置，CLI 不可用时保留结构校验兜底。 */
async function validateCodexConfig(content, filePath, expectedServerTableCount) {
  if (countCodexServerTables(content) !== expectedServerTableCount) {
    throw new AgentError('client_config_invalid', `${filePath} 中雨燕 MCP 配置数量异常，雨燕未修改该文件`);
  }
  const validationHome = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-codex-validate-'));
  try {
    await fs.writeFile(path.join(validationHome, 'config.toml'), content, { mode: 0o600 });
    for (const command of getCodexCliCandidates()) {
      try {
        await execFile(command, ['mcp', 'list'], {
          env: { ...process.env, CODEX_HOME: validationHome },
          timeout: CODEX_VALIDATION_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        });
        return;
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw new AgentError('client_config_invalid', `生成的 Codex 配置无法解析，雨燕未修改原文件：${summarizeCodexValidationError(error)}`);
      }
    }
  } finally {
    await fs.rm(validationHome, { recursive: true, force: true });
  }
}

/** 按服务名替换 Codex MCP 配置，兼容旧版未托管条目。 */
function mergeCodexConfig(source, launchSpec) {
  const block = createCodexBlock(launchSpec);
  const withoutServerConfig = removeCodexServerConfig(source);
  return `${withoutServerConfig}${withoutServerConfig ? '\n\n' : ''}${block}\n`;
}

/** 解析 JSON 配置。 */
function parseJsonConfig(source, filePath) {
  if (!source.trim()) return {};
  try {
    const value = JSON.parse(source);
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('根节点必须是对象');
    return value;
  } catch (error) {
    throw new AgentError('client_config_invalid', `${filePath} 不是有效 JSON，雨燕未修改该文件：${error.message}`);
  }
}

/** 获取所有受支持客户端状态。 */
export async function getAgentClientStatuses() {
  const launcher = await ensureStableLauncher();
  return Promise.all(Object.entries(CLIENTS).map(async ([client, config]) => {
    const source = await readText(config.filePath);
    let installed = false;
    let needsRepair = false;
    const launchSpec = createLaunchSpec(launcher, client);
    if (config.format === 'toml') {
      const serverTableCount = countCodexServerTables(source);
      installed = serverTableCount > 0 || source.includes(CODEX_BEGIN) || source.includes(CODEX_END);
      needsRepair = installed && (serverTableCount !== 1 || !source.includes(createCodexBlock(launchSpec)));
    } else {
      try {
        const parsed = parseJsonConfig(source, config.filePath);
        const entry = parsed.mcpServers?.[SERVER_NAME];
        installed = Boolean(entry);
        needsRepair = installed && (
          entry?.command !== launchSpec.command
          || JSON.stringify(entry?.args || []) !== JSON.stringify(launchSpec.args)
        );
      } catch {
        needsRepair = true;
      }
    }
    return { client, label: config.label, configPath: config.filePath, installed, needsRepair };
  }));
}

/** 安装或修复指定客户端。 */
export async function installAgentClient(client) {
  const config = CLIENTS[client];
  if (!config) throw new AgentError('client_not_supported', '仅支持 Codex、Cursor 和 Antigravity');
  const launcher = await ensureStableLauncher();
  const launchSpec = createLaunchSpec(launcher, client);
  const source = await readText(config.filePath);
  let content;
  if (config.format === 'toml') {
    content = mergeCodexConfig(source, launchSpec);
    await validateCodexConfig(content, config.filePath, 1);
  } else {
    const parsed = parseJsonConfig(source, config.filePath);
    parsed.mcpServers = parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)
      ? parsed.mcpServers
      : {};
    parsed.mcpServers[SERVER_NAME] = launchSpec;
    content = `${JSON.stringify(parsed, null, 2)}\n`;
  }
  const backupPath = await atomicWrite(config.filePath, content, source);
  return { client, configPath: config.filePath, backupPath, installed: true, launcherPath: launcher.path };
}

/** 卸载指定客户端中的雨燕 MCP 配置。 */
export async function uninstallAgentClient(client) {
  const config = CLIENTS[client];
  if (!config) throw new AgentError('client_not_supported', '仅支持 Codex、Cursor 和 Antigravity');
  const source = await readText(config.filePath);
  if (!source) return { client, configPath: config.filePath, removed: false, backupPath: '' };
  let content;
  if (config.format === 'toml') {
    content = removeCodexServerConfig(source);
    content = content ? `${content}\n` : '';
    await validateCodexConfig(content, config.filePath, 0);
  } else {
    const parsed = parseJsonConfig(source, config.filePath);
    if (parsed.mcpServers && typeof parsed.mcpServers === 'object') delete parsed.mcpServers[SERVER_NAME];
    content = `${JSON.stringify(parsed, null, 2)}\n`;
  }
  if (content === source) return { client, configPath: config.filePath, removed: false, backupPath: '' };
  const backupPath = await atomicWrite(config.filePath, content, source);
  return { client, configPath: config.filePath, removed: true, backupPath };
}

/** 返回供其他 MCP 客户端复制的标准 stdio 配置。 */
export async function getGenericAgentClientConfig() {
  const launcher = await ensureStableLauncher();
  return {
    config: {
      mcpServers: {
        [SERVER_NAME]: createLaunchSpec(launcher, 'generic'),
      },
    },
    launcher: {
      path: launcher.path,
      runtimeMode: launcher.runtimeMode,
      stable: launcher.stable,
      sameMachineOnly: true,
    },
  };
}
