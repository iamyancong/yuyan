/**
 * Agent 项目识别与授权边界服务。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getProjectGrant } from './agent-store.mjs';

const execFileAsync = promisify(execFile);

/** 带错误代码的 Agent 领域异常。 */
export class AgentError extends Error {
  /**
   * @param {string} code 稳定错误代码
   * @param {string} message 用户可理解的消息
   * @param {{retryable?: boolean, details?: Record<string, unknown>}} options 附加信息
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.retryable = Boolean(options.retryable);
    this.details = options.details || undefined;
  }
}

/** 执行只读 Git 命令。 */
async function runGit(cwd, args, fallback = '') {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return String(stdout || '').trim();
  } catch {
    return fallback;
  }
}

/** 规范化远程仓库标识，剔除协议、URL 凭据与默认端口，实现 SSH 与 HTTP 智能兼容。 */
export function normalizeRepositoryUrl(value) {
  let source = String(value || '').trim();
  if (!source) return '';

  // 1. 预处理：去掉协议前缀 ssh://, http://, https://
  source = source.replace(/^(?:ssh|https?):\/\//i, '');

  // 2. 处理 URL 中的认证凭据 username:password@ 或 git@
  source = source.replace(/^[^/@\s]+@/, '');

  // 3. 处理 SCP 冒号格式：host:port/repo 或 host:repo
  if (source.includes(':') && !source.startsWith('[')) {
    const firstSlash = source.indexOf('/');
    const firstColon = source.indexOf(':');
    if (firstColon !== -1 && (firstSlash === -1 || firstColon < firstSlash)) {
      const hostPart = source.slice(0, firstColon);
      const afterColon = source.slice(firstColon + 1);
      const portMatch = afterColon.match(/^(\d+)(\/.*)?$/);
      if (portMatch) {
        const port = portMatch[1];
        const pathPart = portMatch[2] || '';
        source = `${hostPart}:${port}${pathPart}`;
      } else {
        source = `${hostPart}/${afterColon}`;
      }
    }
  }

  // 4. 清理路径：折叠多重斜线，去除首尾斜线
  source = source.replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');

  // 5. 分离 host[:port] 和 path
  const slashIdx = source.indexOf('/');
  let hostPort = slashIdx !== -1 ? source.slice(0, slashIdx) : source;
  let repoPath = slashIdx !== -1 ? source.slice(slashIdx + 1) : '';

  // 6. 统一小写并去除 SSH/HTTP 默认端口 (:22, :80, :443)
  hostPort = hostPort.toLowerCase();
  if (hostPort.endsWith(':22') || hostPort.endsWith(':80') || hostPort.endsWith(':443')) {
    hostPort = hostPort.slice(0, hostPort.lastIndexOf(':'));
  }

  // 7. 清理末尾的 .git
  repoPath = repoPath.replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();

  return repoPath ? `${hostPort}/${repoPath}` : hostPort;
}

/** 判断路径是否为磁盘根目录或整个用户目录。 */
function assertSafeWorkspaceRoot(workspacePath) {
  const parsedRoot = path.parse(workspacePath).root;
  const home = path.resolve(os.homedir());
  if (workspacePath === parsedRoot || workspacePath === home) {
    throw new AgentError('unsafe_workspace_scope', '禁止授权磁盘根目录或整个用户目录');
  }
}

/** 读取 JSON，失败时返回空值。 */
async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 识别真实 Git 工作区、项目类型和当前提交。
 * @param {string} requestedPath Agent 提供的当前路径
 * @returns {Promise<Record<string, unknown>>} 工作区信息
 */
export async function inspectAgentWorkspace(requestedPath) {
  if (!requestedPath || typeof requestedPath !== 'string') {
    throw new AgentError('workspace_required', '请提供当前项目 workspacePath');
  }
  let realRequestedPath;
  try {
    realRequestedPath = await fs.realpath(path.resolve(requestedPath));
  } catch {
    throw new AgentError('workspace_not_found', '项目路径不存在或当前用户无权访问');
  }
  const stat = await fs.stat(realRequestedPath);
  if (!stat.isDirectory()) throw new AgentError('workspace_not_directory', 'workspacePath 必须是目录');
  const gitRootCandidate = await runGit(realRequestedPath, ['rev-parse', '--show-toplevel']);
  if (!gitRootCandidate) throw new AgentError('git_workspace_required', '当前路径不属于 Git 工作区');
  const workspacePath = await fs.realpath(gitRootCandidate);
  assertSafeWorkspaceRoot(workspacePath);
  const relativePath = path.relative(workspacePath, realRequestedPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new AgentError('workspace_escape_detected', '规范化路径已逃逸 Git 工作区');
  }

  const packageJson = await readJson(path.join(workspacePath, 'package.json'));
  const pomText = await fs.readFile(path.join(workspacePath, 'pom.xml'), 'utf8').catch(() => '');
  const hasPnpmLock = await fs.access(path.join(workspacePath, 'pnpm-lock.yaml')).then(() => true).catch(() => false);
  const hasYarnLock = await fs.access(path.join(workspacePath, 'yarn.lock')).then(() => true).catch(() => false);
  const hasNpmLock = await fs.access(path.join(workspacePath, 'package-lock.json')).then(() => true).catch(() => false);
  const projectType = pomText ? 'backend' : packageJson ? 'frontend' : 'unknown';
  const packageManager = hasPnpmLock ? 'pnpm' : hasYarnLock ? 'yarn' : hasNpmLock ? 'npm' : packageJson?.packageManager?.split('@')[0] || '';
  const remoteUrl = normalizeRepositoryUrl(await runGit(workspacePath, ['remote', 'get-url', 'origin']));
  const branch = await runGit(workspacePath, ['branch', '--show-current']);
  const commitSha = await runGit(workspacePath, ['rev-parse', 'HEAD']);
  const dirty = Boolean(await runGit(workspacePath, ['status', '--porcelain']));
  const javaVersion = pomText.match(/<(?:java\.version|maven\.compiler\.source)>\s*([^<]+)\s*</i)?.[1]?.trim() || '';

  return {
    workspacePath,
    remoteUrl,
    projectName: String(packageJson?.name || pomText.match(/<artifactId>\s*([^<]+)\s*</i)?.[1] || path.basename(workspacePath)),
    projectType,
    packageManager,
    packageScripts: Object.keys(packageJson?.scripts || {}).sort(),
    javaVersion,
    branch,
    commitSha,
    dirty,
  };
}

/**
 * 校验客户端对工作区的精确授权。
 * @param {string} client MCP 客户端
 * @param {string} workspacePath 项目路径
 * @returns {Promise<{workspace: Record<string, unknown>, grant: object}>} 工作区与授权
 */
export async function requireProjectGrant(client, workspacePath) {
  const workspace = await inspectAgentWorkspace(workspacePath);
  const grant = getProjectGrant(client, workspace.workspacePath, workspace.remoteUrl);
  if (!grant) {
    throw new AgentError('authorization_required', '当前客户端尚未获得该项目授权，请在雨燕中确认', {
      details: { workspace },
    });
  }
  return { workspace, grant };
}
