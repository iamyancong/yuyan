/**
 * 后端项目本地工作区服务
 * @description 负责代码同步、Maven 命令、项目检测、Jar 定位和 OpenAPI 生成。
 */

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DEPLOY_DATA_DIR, DEPLOY_OPENAPI_DIR } from '../config/constants.mjs';
import { buildAuthUrl } from './git-service.mjs';
import { shellQuote } from './ssh-service.mjs';
import {
  createOpenApiArtifact,
  getJdk,
  getLatestOpenApiArtifact,
  getTarget,
} from './deploy-store.mjs';
import {
  parseJavaMajorVersion,
  OPENAPI_MAX_BYTES,
  redactDeployLog,
  validateOpenApiContent,
  validateRepositoryRelativePath,
} from './backend-domain.mjs';

/** Maven/OpenAPI 默认超时 */
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

/** OpenAPI 默认超时 */
const DEFAULT_OPENAPI_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * 生成短哈希。
 * @param {string|Buffer} value 原始值
 * @returns {string} SHA-256
 */
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * 解析后端工作区路径。
 * @param {number} targetId 目标 ID
 * @param {string} branch 分支
 * @returns {{workspaceRoot: string, repoDir: string}}
 */
export function resolveBackendWorkspace(targetId, branch) {
  const branchHash = sha256(String(branch || 'default')).slice(0, 16);
  const workspaceRoot = path.join(DEPLOY_DATA_DIR, 'cache', 'workspaces', String(targetId), branchHash);
  return { workspaceRoot, repoDir: path.join(workspaceRoot, 'repo') };
}

/**
 * 以流式日志执行本地命令。
 * @param {string} command 命令文本
 * @param {Object} options 执行选项
 * @returns {Promise<{stdout: string, stderr: string}>} 执行结果
 */
export function runBackendLocalCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('任务已取消'));
      return;
    }
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(options.env || {}) },
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = Number(options.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS);

    /** 结束进程组。 */
    const killTree = (signalName) => {
      if (!child.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, signalName);
        else child.kill(signalName);
      } catch {
        child.kill(signalName);
      }
    };

    const killTimer = setTimeout(() => {
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 3000).unref?.();
    }, timeoutMs);

    /** 取消事件。 */
    const onAbort = () => {
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 3000).unref?.();
    };
    options.signal?.addEventListener?.('abort', onAbort, { once: true });

    /** 输出日志行。 */
    const consume = (level, chunk) => {
      const text = chunk.toString();
      if (level === 'info') stdout += text;
      else stderr += text;
      for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
        options.onLog?.(level, redactDeployLog(line));
      }
    };
    child.stdout?.on('data', (chunk) => consume('info', chunk));
    child.stderr?.on('data', (chunk) => consume('warn', chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      options.signal?.removeEventListener?.('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      options.signal?.removeEventListener?.('abort', onAbort);
      if (options.signal?.aborted) {
        reject(new Error('任务已取消'));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const suffix = redactDeployLog(stderr || stdout).trim();
      reject(new Error(`${options.label || '命令'}执行失败，退出码 ${code}${suffix ? `\n${suffix}` : ''}`));
    });
  });
}

/**
 * 构建带认证的克隆地址。
 * @param {string} repositoryUrl 仓库地址
 * @param {string} token GitLab Token
 * @returns {string} 克隆地址
 */
function resolveCloneUrl(repositoryUrl, token) {
  if (!token || !/^https?:\/\//i.test(repositoryUrl)) return repositoryUrl;
  return buildAuthUrl(repositoryUrl, token);
}

/**
 * 同步后端项目工作区到指定分支。
 * @param {Object} options 同步选项
 * @returns {Promise<{workspaceRoot: string, repoDir: string, commitSha: string, commitMessage: string, commitAuthor: string}>}
 */
export async function syncBackendWorkspace(options) {
  const { target, branch, gitlabToken = '', signal, log = () => {} } = options;
  const { workspaceRoot, repoDir } = resolveBackendWorkspace(target.id, branch);
  const cloneUrl = resolveCloneUrl(target.repositoryUrl, gitlabToken);
  const gitDir = await fs.stat(path.join(repoDir, '.git')).catch(() => null);
  await fs.mkdir(workspaceRoot, { recursive: true });
  if (!gitDir?.isDirectory()) {
    await fs.rm(repoDir, { recursive: true, force: true });
    log('info', '首次创建后端项目工作区', 'clone');
    await runBackendLocalCommand(`git clone --depth 1 --branch ${shellQuote(branch)} ${shellQuote(cloneUrl)} ${shellQuote(repoDir)}`, {
      label: 'git clone',
      signal,
      onLog: (level, message) => log(level, message, 'clone'),
    });
  } else {
    log('info', '复用后端项目工作区并同步最新提交', 'clone');
    await runBackendLocalCommand(`git remote set-url origin ${shellQuote(cloneUrl)}`, { cwd: repoDir, label: '设置仓库地址', signal });
    try {
      await runBackendLocalCommand(`git fetch --depth 1 origin ${shellQuote(branch)}`, {
        cwd: repoDir,
        label: 'git fetch',
        signal,
        onLog: (level, message) => log(level, message, 'clone'),
      });
      await runBackendLocalCommand('git reset --hard', { cwd: repoDir, label: '重置工作区', signal });
      await runBackendLocalCommand('git clean -fdx', { cwd: repoDir, label: '清理构建残留', signal });
      await runBackendLocalCommand(`git checkout -B ${shellQuote(branch)} FETCH_HEAD`, { cwd: repoDir, label: '切换分支', signal });
      await runBackendLocalCommand('git reset --hard FETCH_HEAD', { cwd: repoDir, label: '同步最新提交', signal });
    } finally {
      await runBackendLocalCommand(`git remote set-url origin ${shellQuote(target.repositoryUrl)}`, {
        cwd: repoDir,
        label: '还原仓库地址',
      }).catch(() => {});
    }
  }
  await runBackendLocalCommand(`git remote set-url origin ${shellQuote(target.repositoryUrl)}`, { cwd: repoDir, label: '清理认证地址' }).catch(() => {});
  const [{ stdout: commitSha }, { stdout: commitMessage }, { stdout: commitAuthor }] = await Promise.all([
    runBackendLocalCommand('git rev-parse HEAD', { cwd: repoDir, label: '读取 commit', signal }),
    runBackendLocalCommand('git log -1 --pretty=%s', { cwd: repoDir, label: '读取提交信息', signal }),
    runBackendLocalCommand('git log -1 --pretty=%an', { cwd: repoDir, label: '读取提交人', signal }),
  ]);
  return {
    workspaceRoot,
    repoDir,
    commitSha: commitSha.trim(),
    commitMessage: commitMessage.trim(),
    commitAuthor: commitAuthor.trim(),
  };
}

/**
 * 创建文件 SHA-256。
 * @param {string} filePath 文件路径
 * @returns {Promise<string>} SHA-256
 */
export function createFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * 将简单 glob 文件名转换为正则。
 * @param {string} pattern 文件名模式
 * @returns {RegExp} 正则
 */
function globNameToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/**
 * 解析唯一 Jar 构建产物。
 * @param {string} repoDir 仓库目录
 * @param {string} artifactPattern Jar 相对路径或简单 glob
 * @returns {Promise<{jarPath: string, jarName: string}>} Jar 信息
 */
export async function resolveBackendArtifact(repoDir, artifactPattern) {
  const normalized = validateRepositoryRelativePath(artifactPattern, 'Jar 产物路径', { allowGlob: true });
  const absolutePattern = path.resolve(repoDir, normalized);
  if (!/[*?]/.test(normalized)) {
    const stat = await fs.stat(absolutePattern).catch(() => null);
    if (!stat?.isFile()) throw new Error(`未找到 Jar 产物：${normalized}`);
    if (!absolutePattern.endsWith('.jar')) throw new Error('后端产物必须是 Jar 文件');
    return { jarPath: absolutePattern, jarName: path.basename(absolutePattern) };
  }
  const dir = path.dirname(absolutePattern);
  const matcher = globNameToRegExp(path.basename(absolutePattern));
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter((entry) => entry.isFile() && matcher.test(entry.name) && entry.name.endsWith('.jar'))
    .map((entry) => entry.name)
    .filter((name) => !/(?:-sources|-javadoc)\.jar$|\.original$|^original-/i.test(name));
  if (!candidates.length) throw new Error(`未找到匹配的 Jar 产物：${normalized}`);
  if (candidates.length > 1) throw new Error(`Jar 产物匹配到多个文件，请缩小规则：${candidates.join('、')}`);
  return { jarPath: path.join(dir, candidates[0]), jarName: candidates[0] };
}

/**
 * 递归查找项目 POM，忽略构建目录。
 * @param {string} root 根目录
 * @param {number} depth 最大深度
 * @returns {Promise<string[]>} POM 文件列表
 */
async function findPomFiles(root, depth = 4) {
  const result = [];
  const walk = async (dir, level) => {
    if (level > depth) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (['.git', 'target', 'node_modules'].includes(entry.name)) continue;
      const filePath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === 'pom.xml') result.push(filePath);
      if (entry.isDirectory()) await walk(filePath, level + 1);
    }
  };
  await walk(root, 0);
  return result;
}

/**
 * 从项目文件检测后端配置。
 * @param {string} repoDir 仓库目录
 * @returns {Promise<Object>} 检测结果
 */
export async function inspectBackendRepository(repoDir) {
  const pomFiles = await findPomFiles(repoDir);
  if (!pomFiles.length) throw new Error('未找到 Maven pom.xml');
  const rootPomPath = path.join(repoDir, 'pom.xml');
  const rootPom = await fs.readFile(rootPomPath, 'utf8').catch(() => '');
  const javaVersion = rootPom.match(/<java\.version>\s*([^<]+)\s*<\/java\.version>/)?.[1]?.trim()
    || rootPom.match(/<maven\.compiler\.(?:release|target)>\s*([^<]+)\s*<\/maven\.compiler\.(?:release|target)>/)?.[1]?.trim()
    || '';
  let starterPom = '';
  let starterContent = '';
  for (const pomPath of pomFiles) {
    const content = await fs.readFile(pomPath, 'utf8');
    if (content.includes('spring-boot-maven-plugin')) {
      starterPom = path.relative(repoDir, pomPath).replace(/\\/g, '/');
      starterContent = content;
      break;
    }
  }
  if (!starterPom) throw new Error('未找到包含 spring-boot-maven-plugin 的启动模块');
  const starterDir = path.dirname(path.join(repoDir, starterPom));
  const modulePomContent = starterContent.replace(/<parent>[\s\S]*?<\/parent>/, '');
  const artifactId = modulePomContent.match(/<artifactId>\s*([^<]+)\s*<\/artifactId>/)?.[1]?.trim() || path.basename(starterDir);
  const resourceDir = path.join(starterDir, 'src', 'main', 'resources');
  const bootstrapFiles = (await fs.readdir(resourceDir).catch(() => []))
    .filter((name) => /^bootstrap.*\.ya?ml$/i.test(name));
  const bootstrapName = bootstrapFiles.includes('bootstrap.yml') ? 'bootstrap.yml' : bootstrapFiles[0] || '';
  const bootstrap = bootstrapName ? await fs.readFile(path.join(resourceDir, bootstrapName), 'utf8') : '';
  const port = Number(bootstrap.match(/(?:^|\n)server:\s*[\s\S]{0,160}?\n\s+port:\s*(\d+)/)?.[1] || 0);
  const applicationName = bootstrap.match(/(?:^|\n)\s+application:\s*[\s\S]{0,120}?\n\s+name:\s*([^\s#]+)/)?.[1]?.trim() || artifactId;
  const managementBase = bootstrap.match(/(?:^|\n)\s+base-path:\s*([^\s#]+)/)?.[1]?.trim() || '/actuator';
  const profiles = bootstrap.match(/(?:^|\n)\s+active:\s*([^\n#]+)/)?.[1]?.trim() || '';
  const smartDocPath = path.join(resourceDir, 'smart-doc.json');
  const smartDocRaw = await fs.readFile(smartDocPath, 'utf8').catch(() => '');
  const outPath = smartDocRaw.match(/"outPath"\s*:\s*"([^"]+)"/)?.[1] || 'target/openapi';
  const starterRelative = path.relative(repoDir, starterDir).replace(/\\/g, '/');
  return {
    javaVersion,
    javaMajorVersion: parseJavaMajorVersion(javaVersion),
    starterPom,
    starterModule: starterRelative,
    applicationName,
    serverPort: port,
    springProfiles: profiles,
    bootstrapFiles,
    healthCheckPath: `${managementBase.replace(/\/$/, '')}/health`,
    buildCommand: `./mvnw -nsu clean package -pl ${starterRelative} -am -DskipTests`,
    artifactPattern: `${starterRelative}/target/${artifactId}-*.jar`,
    openapiCommand: smartDocRaw ? `./mvnw -nsu -f ${starterPom} smart-doc:openapi` : '',
    openapiOutputPath: smartDocRaw ? `${starterRelative}/${outPath}/openapi.json` : '',
  };
}

/**
 * 同步并检测目标后端项目。
 * @param {number} targetId 目标 ID
 * @param {Object} options 检测选项
 * @returns {Promise<Object>} 检测结果
 */
export async function inspectBackendTarget(targetId, options = {}) {
  const target = await getTarget(targetId);
  if (!target || target.projectType !== 'backend') throw new Error('后端部署目标不存在');
  const branch = options.branch || target.defaultBranch;
  const workspace = await syncBackendWorkspace({ target, branch, ...options });
  return { ...(await inspectBackendRepository(workspace.repoDir)), branch, commitSha: workspace.commitSha };
}

/**
 * 生成并缓存 OpenAPI。
 * @param {number} targetId 目标 ID
 * @param {Object} options 生成选项
 * @returns {Promise<Object>} OpenAPI 元数据
 */
export async function generateTargetOpenApi(targetId, options = {}) {
  const target = await getTarget(targetId);
  if (!target || target.projectType !== 'backend') throw new Error('后端部署目标不存在');
  if (!target.openapiCommand || !target.openapiOutputPath) throw new Error('请先配置 OpenAPI 生成命令和输出路径');
  const branch = options.branch || target.defaultBranch;
  const log = options.log || (() => {});
  const workspace = await syncBackendWorkspace({ target, branch, gitlabToken: options.gitlabToken, signal: options.signal, log });
  if (!options.force) {
    const cached = await getLatestOpenApiArtifact(target.id, branch, workspace.commitSha);
    if (cached && await fs.stat(cached.filePath).catch(() => null)) {
      log('success', '当前 commit 已存在 OpenAPI 缓存', 'cache');
      return cached;
    }
  }
  const jdk = target.buildJdkId ? await getJdk(target.buildJdkId) : null;
  if (!jdk || jdk.status !== 'available' || !jdk.majorVersion) throw new Error('构建 JDK 未检测通过，请先在 JDK 管理中检测');
  const env = { JAVA_HOME: jdk.homePath, PATH: `${path.join(jdk.homePath, 'bin')}:${process.env.PATH}` };
  log('info', `使用 ${jdk.name} 生成 OpenAPI`, 'openapi');
  await runBackendLocalCommand(target.openapiCommand, {
    cwd: workspace.repoDir,
    env,
    signal: options.signal,
    timeoutMs: DEFAULT_OPENAPI_TIMEOUT_MS,
    label: '生成 OpenAPI',
    onLog: (level, message) => log(level, message, 'openapi'),
  });
  const relativeOutput = validateRepositoryRelativePath(target.openapiOutputPath, 'OpenAPI 输出路径');
  const outputPath = path.resolve(workspace.repoDir, relativeOutput);
  const outputStat = await fs.stat(outputPath).catch(() => null);
  if (outputStat?.size > OPENAPI_MAX_BYTES) throw new Error('OpenAPI 文件超过 20MB，已拒绝预览和缓存');
  const content = await fs.readFile(outputPath).catch(() => null);
  if (!content) throw new Error(`OpenAPI 命令执行完成，但未找到输出文件：${relativeOutput}`);
  const validated = validateOpenApiContent(content);
  const branchName = branch.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60) || 'branch';
  const fileName = `${target.serviceName || target.projectName}-${branchName}-${workspace.commitSha.slice(0, 8)}-openapi.json`;
  const artifactDir = path.join(DEPLOY_OPENAPI_DIR, String(target.id), branchName);
  const filePath = path.join(artifactDir, fileName);
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(filePath, validated.pretty, 'utf8');
  const artifact = await createOpenApiArtifact({
    targetId: target.id,
    branch,
    commitSha: workspace.commitSha,
    fileName,
    filePath,
    sha256: sha256(validated.pretty),
    sizeBytes: validated.size,
  });
  log('success', `OpenAPI 已生成：${fileName}`, 'finish');
  return artifact;
}
