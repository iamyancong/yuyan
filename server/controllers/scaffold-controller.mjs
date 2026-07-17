/**
 * 脚手架创建控制器
 * @description 处理脚手架项目创建的核心业务逻辑
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GITLAB_HOST, GITLAB_TOKEN, PORT } from '../config/constants.mjs';
import { ensureDir, ensureGitignore, cleanup, normalizeBase } from '../utils/file-utils.mjs';
import { parseGitPushError } from '../utils/error-parser.mjs';
import { withHiddenWindow } from '../utils/child-process.mjs';
import { createProject, updateProject, deleteProject, checkTokenPermissions } from '../services/gitlab-service.mjs';
import { initAndPushRepo } from '../services/git-service.mjs';
import { pullLatestTemplate, getTemplateScriptPath } from '../services/template-service.mjs';
import { getScaffoldArchivePath, registerScaffoldDownload } from './download-controller.mjs';

function isProgressStreamRequest(req) {
  const streamQuery = String(req.query?.stream || '').toLowerCase();
  if (streamQuery === '1' || streamQuery === 'true') return true;

  const accept = String(req.headers.accept || '');
  const streamHeader = String(req.headers['x-progress-stream'] || '');
  return accept.includes('application/x-ndjson') || accept.includes('text/event-stream') || streamHeader === '1';
}

function splitLines(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function createProgressEmitter(res, streamMode) {
  const write = (payload) => {
    const event = {
      timestamp: new Date().toISOString(),
      ...payload,
    };

    if (streamMode && !res.writableEnded) {
      res.write(`${JSON.stringify(event)}\n`);
    }

    return event;
  };

  return {
    stage(stage, percent, message, detail = '') {
      return write({
        type: 'stage',
        stage,
        percent,
        message,
        detail,
      });
    },
    log(level, message, stage = '') {
      return write({
        type: 'log',
        level,
        stage,
        message,
      });
    },
    result(data) {
      return write({
        type: 'result',
        data,
      });
    },
    error(message, stage = '') {
      return write({
        type: 'error',
        stage,
        message,
      });
    },
  };
}

function runCommand(command, args, { cwd, label, onStdout, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, withHiddenWindow({
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onStdout?.(text);
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onStderr?.(text);
    });

    child.on('error', reject);

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const suffix = stderr || stdout ? `\n${stderr || stdout}` : '';
      reject(new Error(`${label || command} 执行失败，退出码 ${code}${suffix}`));
    });
  });
}

async function pathExists(targetPath) {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content);
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function compareStableVersions(a, b) {
  const parse = (version) => String(version).replace(/^v/, '').split('-')[0].split('.').map((part) => Number(part));
  const [aMajor = 0, aMinor = 0, aPatch = 0] = parse(a);
  const [bMajor = 0, bMinor = 0, bPatch = 0] = parse(b);

  if (aMajor !== bMajor) return aMajor - bMajor;
  if (aMinor !== bMinor) return aMinor - bMinor;
  return aPatch - bPatch;
}

async function fetchLatestPackageVersion(packageName, cwd) {
  try {
    const { stdout } = await runCommand('npm', ['view', packageName, 'versions', '--json'], {
      cwd,
      label: `获取 ${packageName} 版本`,
    });
    const rawVersions = JSON.parse(stdout);
    const versions = (Array.isArray(rawVersions) ? rawVersions : [rawVersions])
      .filter((version) => typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version));

    if (versions.length === 0) {
      return null;
    }

    return versions.sort(compareStableVersions).at(-1);
  } catch (error) {
    return null;
  }
}

async function syncGeneratedProjectDependencyVersions(projectDir, emit) {
  const packageJsonPath = path.join(projectDir, 'packages', 'package.json');
  if (!(await pathExists(packageJsonPath))) {
    emit?.log('warn', '未找到 packages/package.json，跳过 @ycwang-dev 版本校正', 'generate');
    return;
  }

  const packageJson = await readJson(packageJsonPath);
  const packagesDir = path.dirname(packageJsonPath);
  const packagesToSync = [
    '@ycwang-dev/components',
    '@ycwang-dev/hooks',
    '@ycwang-dev/utils',
  ];

  emit?.log('info', '开始校正生成项目中的 @ycwang-dev 依赖版本', 'generate');

  let changed = false;
  for (const packageName of packagesToSync) {
    const latestVersion = await fetchLatestPackageVersion(packageName, projectDir);
    if (!latestVersion) {
      emit?.log('warn', `${packageName} 最新版本获取失败，保留当前值`, 'generate');
      continue;
    }

    if (!packageJson.dependencies?.[packageName]) {
      continue;
    }

    const newRange = `^${latestVersion}`;
    const oldRange = packageJson.dependencies[packageName];
    if (oldRange === newRange) {
      emit?.log('info', `${packageName} 已是最新版本 ${newRange}`, 'generate');
      continue;
    }

    packageJson.dependencies[packageName] = newRange;
    changed = true;
    emit?.log('success', `${packageName} 已更新：${oldRange} -> ${newRange}`, 'generate');
  }

  if (!changed) {
    return;
  }

  await writeJson(packageJsonPath, packageJson);

  try {
    emit?.log('info', '正在刷新 packages/pnpm-lock.yaml', 'generate');
    await runCommand('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], {
      cwd: packagesDir,
      label: '刷新 packages 锁文件',
      onStdout: (text) => {
        for (const line of splitLines(text)) {
          emit?.log('info', line, 'generate');
        }
      },
      onStderr: (text) => {
        for (const line of splitLines(text)) {
          emit?.log('warn', line, 'generate');
        }
      },
    });
  } catch (lockError) {
    emit?.log('warn', `刷新 packages/pnpm-lock.yaml 失败：${lockError instanceof Error ? lockError.message : String(lockError)}`, 'generate');
  }
}

/**
 * 处理脚手架项目创建请求
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
export async function handleCreateScaffold(req, res) {
  try {
    console.log('[scaffold-controller] 收到创建请求:', JSON.stringify(req.body || {}, null, 2));

    // 1. 解析请求参数
    const {
      appName,
      appNameZh = '',
      description = '',
      port = 8081,
      activeRule = '',
      apiBase = '/api',
      proxyTarget = 'http://localhost:3000',
      openapiUrl = '',
      createRepo = false,
      gitlabHost = GITLAB_HOST,
      gitlabToken = GITLAB_TOKEN,
      namespaceId = '2088',
      visibility = 'private',
    } = req.body || {};

    // 2. 参数验证
    if (!appName || typeof appName !== 'string') {
      return res.status(400).json({ error: 'appName 必填' });
    }

    // 3. 处理 proxyTarget（如果是 localhost，使用实际服务器地址）
    let finalProxyTarget = proxyTarget;
    if (proxyTarget === 'http://localhost:3000' || proxyTarget.startsWith('http://localhost') || !proxyTarget || proxyTarget.trim() === '') {
      const host = req.get('host') || `localhost:${PORT}`;
      finalProxyTarget = `http://${host}`;
    }

    const streamMode = isProgressStreamRequest(req);
    if (streamMode) {
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
    }

    const emit = createProgressEmitter(res, streamMode);
    const createRepoStages = createRepo
      ? [
          { key: 'validate', title: '参数校验', percent: 5, detail: '检查应用名、路由与 GitLab 配置' },
          { key: 'pull-template', title: '拉取模板', percent: 18, detail: '同步最新模板仓库' },
          { key: 'generate', title: '生成项目', percent: 42, detail: '写入项目骨架与配置文件' },
          { key: 'install-sync-skills', title: 'Node 同步 skills', percent: 72, detail: '直接调用本地 skills-cli 写入 .agent/skills' },
          { key: 'gitlab-create-push', title: 'GitLab 创建 / 推送', percent: 92, detail: '创建远程仓库并推送代码' },
          { key: 'finalize', title: '完成收口', percent: 100, detail: '整理结果与下一步操作' },
        ]
      : [
          { key: 'validate', title: '参数校验', percent: 5, detail: '检查应用名、路由与基础配置' },
          { key: 'pull-template', title: '拉取模板', percent: 18, detail: '同步最新模板仓库' },
          { key: 'generate', title: '生成项目', percent: 42, detail: '写入项目骨架与配置文件' },
          { key: 'install-sync-skills', title: 'Node 同步 skills', percent: 72, detail: '直接调用本地 skills-cli 写入 .agent/skills' },
          { key: 'package-download', title: '下载包准备', percent: 92, detail: '生成压缩包下载入口' },
          { key: 'finalize', title: '完成收口', percent: 100, detail: '整理结果与下一步操作' },
        ];

    emit.stage(createRepoStages[0].key, createRepoStages[0].percent, createRepoStages[0].title, createRepoStages[0].detail);

    // 4. 拉取最新模板
    console.log('[scaffold-controller] 开始拉取最新模板...');
    emit.log('info', '开始拉取最新模板仓库', 'pull-template');
    emit.stage('pull-template', 18, '拉取模板', '正在同步最新模板仓库');
    await pullLatestTemplate();
    emit.log('success', '模板仓库已同步完成', 'pull-template');

    // 5. 创建临时工作目录
    const workRoot = path.join(os.tmpdir(), `scaffold-${Date.now()}`);
    await ensureDir(workRoot);
    emit.log('info', `创建临时工作目录：${workRoot}`, 'generate');

    // 6. 执行脚手架生成脚本
    const scriptPath = getTemplateScriptPath();
    const projectDir = path.join(workRoot, appName);

    try {
      emit.stage('generate', 42, '生成项目', '正在写入项目骨架与配置文件');
      emit.stage('install-sync-skills', 72, 'Node 同步 skills', '直接调用本地 skills-cli 写入 .agent/skills');
      emit.log('info', '正在通过 Node 调用 skills-cli 同步最新 skills', 'install-sync-skills');
      await executeScaffoldScript({
        scriptPath,
        appName,
        workRoot,
        port,
        activeRule,
        apiBase,
        proxyTarget: finalProxyTarget,
        openapiUrl,
        emit,
      });
    } catch (scriptError) {
      console.error('[scaffold-controller] 脚手架生成失败:', scriptError);
      emit.log('warn', scriptError instanceof Error ? scriptError.message : String(scriptError), 'generate');
      // 继续执行，保留临时文件用于调试
    }

    // 7. 确保项目目录和 .gitignore 存在
    await ensureDir(projectDir);
    await ensureGitignore(projectDir);
    await syncGeneratedProjectDependencyVersions(projectDir, emit);
    emit.log('success', '项目目录与 .gitignore 已准备完成', 'generate');

    let gitlab = null;
    let downloadPath = null;

    // 8. 根据 createRepo 决定后续流程
    if (createRepo) {
      emit.stage('gitlab-create-push', 92, 'GitLab 创建 / 推送', '正在创建远程仓库并推送代码');
      gitlab = await handleGitlabFlow({
        appName,
        description,
        projectDir,
        gitlabHost,
        gitlabToken,
        namespaceId,
        visibility,
        workRoot,
        emit,
      });

      // GitLab 推送成功，立即清理
      await cleanup(workRoot);
      emit.log('success', '临时工作目录已清理', 'finalize');
    } else {
      // 生成下载链接
      const timestamp = Date.now();
      const archiveDir = path.dirname(getScaffoldArchivePath(appName, timestamp));
      const archivePath = getScaffoldArchivePath(appName, timestamp);
      await ensureDir(archiveDir);
      emit.stage('package-download', 92, '下载包准备', '正在打包下载归档');
      emit.log('info', `正在生成压缩包：${path.basename(archivePath)}`, 'package-download');
      await runCommand('zip', ['-rq', archivePath, appName], {
        cwd: workRoot,
        label: '下载包压缩',
      });
      downloadPath = `/scaffold-api/download/${appName}/${timestamp}?t=${Date.now()}`;
      registerScaffoldDownload({
        appName,
        timestamp,
        tempRoot: workRoot,
        projectDir,
        archivePath,
        expiresAt: Date.now() + 1000 * 60 * 60,
      });
      await cleanup(workRoot);
      emit.log('success', '下载压缩包已生成，临时项目目录已清理', 'package-download');
      console.log('[scaffold-controller] 项目已准备好下载:', downloadPath);
      emit.stage('package-download', 92, '下载包准备', '已生成项目下载入口');
      emit.log('success', `下载链接已生成：${downloadPath}`, 'package-download');
    }

    emit.stage('finalize', 100, '完成收口', '正在整理最终结果');

    const responseData = {
      appName,
      appNameZh,
      description,
      activeRule: normalizeBase(activeRule),
      standaloneBase: normalizeBase(`/${appName}`),
      apiBase,
      proxyTarget: finalProxyTarget,
      openapiUrl: openapiUrl || null,
      gitlab,
      downloadPath,
    };

    // 9. 返回成功响应
    if (streamMode) {
      emit.result(responseData);
      res.end();
      return;
    }

    res.json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error('[scaffold-controller] 未处理的错误:', error);
    if (isProgressStreamRequest(req) && res.headersSent) {
      const message = error instanceof Error ? error.message : '创建失败';
      res.write(`${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'error',
        message,
      })}\n`);
      res.end();
      return;
    }

    if (!res.headersSent) {
      res.status(500).json({
        error: error instanceof Error ? error.message : '创建失败',
      });
    }
  }
}

/**
 * 执行脚手架生成脚本
 * @param {Object} params - 脚本参数
 */
async function executeScaffoldScript({ scriptPath, appName, workRoot, port, activeRule, apiBase, proxyTarget, openapiUrl, emit }) {
  const args = [
    'node',
    scriptPath,
    '--name',
    appName,
    '--target-dir',
    workRoot,
    '--port',
    String(port),
    '--active-rule',
    activeRule,
    '--api-base',
    apiBase,
    '--proxy-target',
    proxyTarget,
  ];

  if (openapiUrl) {
    args.push('--openapi-url', openapiUrl);
  }

  const cmd = ['node', ...args.slice(1)].join(' ');
  console.log('[scaffold-controller] 执行脚手架脚本:', cmd);
  emit?.log('info', `执行脚手架脚本：${cmd}`, 'install-sync-skills');

  const { stdout, stderr } = await runCommand('node', args.slice(1), {
    cwd: process.cwd(),
    label: '脚手架生成脚本',
    onStdout: (text) => {
      for (const line of splitLines(text)) {
        emit?.log('info', line, 'install-sync-skills');
      }
    },
    onStderr: (text) => {
      for (const line of splitLines(text)) {
        emit?.log('warn', line, 'install-sync-skills');
      }
    },
  });

  if (stdout) console.log('[scaffold-controller] 脚本输出:', stdout);
  if (stderr) console.error('[scaffold-controller] 脚本错误:', stderr);
}

/**
 * 处理 GitLab 创建和推送流程
 * @param {Object} params - GitLab 参数
 * @returns {Promise<Object>} GitLab 项目信息（包含推送的分支名称）
 */
async function handleGitlabFlow({ appName, description, projectDir, gitlabHost, gitlabToken, namespaceId, visibility, workRoot, emit }) {
  if (!gitlabHost) throw new Error('gitlabHost 不能为空');
  if (!gitlabToken) throw new Error('gitlabToken 不能为空');

  // 🔥 新增：创建前先检查 Token 权限和用户角色
  console.log('[scaffold-controller] 检查权限...');
  emit?.log('info', '正在检查 GitLab Token 权限', 'gitlab-create-push');
  const { canDelete, canCreate, userInfo, tokenScopes, reason } = await checkTokenPermissions({
    host: gitlabHost,
    token: gitlabToken,
    namespaceId, // 传递 namespaceId 以获取用户在该空间下的角色
  });

  console.log(`[scaffold-controller] 权限检查结果: ${reason}`);
  console.log(`[scaffold-controller] - 能否删除项目: ${canDelete ? '✅' : '❌'}`);
  console.log(`[scaffold-controller] - 能否创建项目: ${canCreate ? '✅' : '❌'}`);

  // 只有两个都满足才能继续
  if (!canDelete || !canCreate) {
    const role = userInfo?.namespaceRole || '未知';
    const username = userInfo?.username || '当前账号';

    let errorMessage = `❌ 权限不足\n\n`;
    errorMessage += `账号：${username}（${role}）\n`;

    // 分析缺失的权限
    const issues = [];
    if (!canDelete) issues.push('Token 缺少 api scope，请在 GitLab → 偏好设置 → 访问令牌 中检查');
    if (!canCreate) issues.push('用户角色不足（需要 Maintainer 或 Owner）');

    errorMessage += `${issues.join('\n')}\n\n请联系项目组管理员授予所需权限`;

    throw new Error(errorMessage);
  }

  let createdProject = null;

  try {
    // 1. 创建 GitLab 项目
    emit?.log('info', '正在创建 GitLab 项目', 'gitlab-create-push');
    createdProject = await createProject({
      host: gitlabHost,
      token: gitlabToken,
      name: appName,
      namespaceId,
      visibility,
      description,
    });

    console.log('[scaffold-controller] GitLab 项目创建成功:', createdProject.name);
    emit?.log('success', `GitLab 项目创建成功：${createdProject.name}`, 'gitlab-create-push');

    // 2. 更新项目信息（强制写入 topics/tags）
    try {
      emit?.log('info', '正在更新 GitLab 项目信息', 'gitlab-create-push');
      await updateProject({
        host: gitlabHost,
        token: gitlabToken,
        projectId: createdProject.id,
        description,
      });
      console.log('[scaffold-controller] GitLab 项目信息已更新');
      emit?.log('success', 'GitLab 项目信息已更新', 'gitlab-create-push');
    } catch (updateError) {
      console.warn('[scaffold-controller] 更新项目信息失败（不阻断流程）:', updateError);
      emit?.log('warn', updateError instanceof Error ? updateError.message : String(updateError), 'gitlab-create-push');
    }

    // 3. 初始化本地仓库并推送（智能分支策略：dev → main）
    emit?.log('info', '正在初始化本地仓库并推送代码', 'gitlab-create-push');
    const { branch } = await initAndPushRepo({
      projectDir,
      remoteUrl: createdProject.http_url_to_repo,
      token: gitlabToken,
      onLog: (entry) => {
        emit?.log(entry.level || 'info', entry.message, 'gitlab-create-push');
      },
      // 移除 branch 参数，使用 git-service 的智能分支策略
    });

    console.log(`[scaffold-controller] ✅ GitLab 推送成功 → ${branch} 分支`);
    emit?.log('success', `代码推送成功 → ${branch} 分支`, 'gitlab-create-push');

    return {
      httpUrl: createdProject.http_url_to_repo,
      webUrl: createdProject.web_url,
      id: createdProject.id,
      path_with_namespace: createdProject.path_with_namespace,
      branch, // 🔥 新增：返回实际推送的分支名称
    };
  } catch (error) {
    console.error('[scaffold-controller] GitLab 流程失败:', error);

    // 🔥 核心改进：使用 error-parser 生成用户友好的错误信息
    let userFriendlyError = parseGitPushError(error);

    // 🔥 关键修复：如果已经创建了 GitLab 项目，则回滚删除
    if (createdProject?.id) {
      console.warn(`[scaffold-controller] 检测到 GitLab 项目已创建 (ID: ${createdProject.id})，开始回滚...`);
      try {
        await deleteProject({
          host: gitlabHost,
          token: gitlabToken,
          projectId: createdProject.id,
        });
        console.log(`[scaffold-controller] ✅ 已成功回滚删除 GitLab 项目: ${createdProject.id}`);
      } catch (rollbackError) {
        console.error(`[scaffold-controller] ❌ 回滚删除 GitLab 项目失败:`, rollbackError);
        console.error(`[scaffold-controller] ⚠️ 请手动删除项目: ${createdProject.web_url}`);
        // 在用户错误提示中追加手动删除提示
        userFriendlyError += `\n\n⚠️ 注意：GitLab 上已创建空项目但回滚失败，请手动删除：${createdProject.web_url}`;
      }
    }

    // 清理本地临时文件
    await cleanup(workRoot);
    emit?.log('info', '本地临时文件已清理', 'gitlab-create-push');

    // 抛出用户友好的错误
    throw new Error(userFriendlyError);
  }
}

/**
 * 处理批量补标请求（为已有项目添加 yuyan-ops 标签）
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
export async function handleBackfillTopics(req, res) {
  try {
    const { ids, gitlabHost = GITLAB_HOST, gitlabToken = GITLAB_TOKEN } = req.body || {};

    // 参数验证
    if (!ids || (Array.isArray(ids) && ids.length === 0)) {
      return res.status(400).json({ error: 'ids 必填，形如 [1354,1327]' });
    }
    if (!gitlabToken) {
      return res.status(400).json({ error: 'gitlabToken 不能为空（可传入或设置环境变量 GITLAB_TOKEN）' });
    }

    // 解析 ID 列表
    const list = Array.isArray(ids)
      ? ids
      : String(ids)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => Number(s));

    // 批量更新
    const results = [];
    for (const pid of list) {
      try {
        await updateProject({
          host: gitlabHost,
          token: gitlabToken,
          projectId: pid,
          description: undefined,
        });
        results.push({ id: pid, ok: true });
      } catch (e) {
        results.push({
          id: pid,
          ok: false,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    res.json({
      success: okCount === results.length,
      ok: okCount,
      total: results.length,
      results,
    });
  } catch (error) {
    console.error('[scaffold-controller] 补标失败:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : '补标失败',
    });
  }
}
