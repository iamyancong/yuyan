/**
 * Git 操作服务
 * @description 封装所有 Git 命令行操作
 */

import { spawn } from 'node:child_process';
import { GIT_USER_NAME, GIT_USER_EMAIL } from '../config/constants.mjs';

function splitLines(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function runGitCommand(args, projectDir, onLog) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      for (const line of splitLines(text)) {
        onLog?.({ level: 'info', message: line });
      }
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of splitLines(text)) {
        onLog?.({ level: 'warn', message: line });
      }
    });

    child.on('error', reject);

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const suffix = stderr || stdout ? `\n${stderr || stdout}` : '';
      reject(new Error(`git ${args.join(' ')} 执行失败，退出码 ${code}${suffix}`));
    });
  });
}

/**
 * 构建带 Token 认证的 Git URL
 * @param {string} httpUrl - 原始 HTTP URL
 * @param {string} token - GitLab Token
 * @returns {string} 带认证信息的 URL
 */
export function buildAuthUrl(httpUrl, token) {
  try {
    const urlObj = new URL(httpUrl);
    urlObj.username = 'oauth2';
    urlObj.password = token;
    return urlObj.toString();
  } catch (error) {
    console.error('[git-service] URL 解析失败:', error);
    throw new Error(`无效的 Git URL: ${httpUrl}`);
  }
}

/**
 * 初始化本地仓库并推送到 GitLab
 * @description 智能分支推送策略：
 *   1. 优先推送到 dev 分支（Developer 权限即可）
 *   2. 如果 dev 推送失败，尝试 main 分支（需要 Maintainer 权限）
 *   3. 两者都失败则抛出错误
 *
 * @param {Object} params - 推送参数
 * @param {string} params.projectDir - 项目本地路径
 * @param {string} params.remoteUrl - GitLab 仓库 HTTP URL
 * @param {string} params.token - GitLab Token
 * @returns {Promise<{branch: string}>} 返回实际推送成功的分支名称
 */
export async function initAndPushRepo({ projectDir, remoteUrl, token, onLog }) {
  console.log('[git-service] 初始化 Git 仓库:', projectDir);
  const log = (level, message) => onLog?.({ level, message });

  try {
    // 1. 初始化仓库
    log('info', '执行 git init');
    await runGitCommand(['init'], projectDir, onLog);
    console.log('[git-service] ✓ git init');
    log('success', 'git init 完成');

    // 2. 添加所有文件
    log('info', '执行 git add -A');
    await runGitCommand(['add', '-A'], projectDir, onLog);
    console.log('[git-service] ✓ git add -A');
    log('success', 'git add -A 完成');

    // 3. 提交代码
    log('info', '执行 git commit');
    await runGitCommand(['-c', `user.name=${GIT_USER_NAME}`, '-c', `user.email=${GIT_USER_EMAIL}`, 'commit', '-m', 'feat: init microapp'], projectDir, onLog);
    console.log('[git-service] ✓ git commit');
    log('success', 'git commit 完成');

    // 4. 添加远程仓库（使用带认证的 URL）
    const authUrl = buildAuthUrl(remoteUrl, token);
    await runGitCommand(['remote', 'remove', 'origin'], projectDir, onLog).catch(() => {});
    log('info', '执行 git remote add origin');
    await runGitCommand(['remote', 'add', 'origin', authUrl], projectDir, onLog);
    console.log('[git-service] ✓ git remote add origin');
    log('success', 'git remote add origin 完成');

    // 5. 智能分支推送策略
    const branchesToTry = [
      { name: 'dev', description: 'dev 分支（推荐，Developer 权限即可）' },
      { name: 'main', description: 'main 分支（需要 Maintainer 权限）' },
    ];

    let lastError = null;
    let pushedBranch = null;

    for (const { name: branch, description } of branchesToTry) {
      try {
        console.log(`[git-service] 尝试推送到 ${description}...`);
        log('info', `尝试推送到 ${description}`);

        // 重命名/创建分支
        await runGitCommand(['branch', '-M', branch], projectDir, onLog);
        console.log(`[git-service] ✓ git branch -M ${branch}`);
        log('success', `git branch -M ${branch} 完成`);

        // 推送到远程
        const { stdout, stderr } = await runGitCommand(['push', '-u', 'origin', branch], projectDir, onLog);
        if (stdout) console.log('[git-service] git push stdout:', stdout);
        if (stderr) console.log('[git-service] git push stderr:', stderr);

        console.log(`[git-service] ✅ 代码推送成功 → ${branch} 分支`);
        log('success', `代码推送成功 → ${branch} 分支`);
        pushedBranch = branch;
        break; // 成功则跳出循环
      } catch (error) {
        console.warn(`[git-service] ⚠️ 推送到 ${branch} 分支失败:`, error.message);
        log('warn', `推送到 ${branch} 分支失败：${error.message}`);
        lastError = error;
        // 继续尝试下一个分支
      }
    }

    if (!pushedBranch) {
      // 所有分支都推送失败
      console.error('[git-service] ❌ 所有分支推送均失败');
      throw lastError || new Error('所有分支推送均失败');
    }

    return { branch: pushedBranch };
  } catch (error) {
    console.error('[git-service] Git 操作失败:', error.message);
    throw error; // 抛出原始错误，由上层使用 error-parser 解析
  }
}
