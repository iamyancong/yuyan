/**
 * 模板仓库管理服务
 * @description 负责拉取和更新前端模板仓库
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { TEMPLATE_REPO_PATH, TEMPLATE_REPO_URL, TEMPLATE_BRANCH, GITLAB_TOKEN, GITLAB_HOST } from '../config/constants.mjs';
import { withHiddenWindow } from '../utils/child-process.mjs';
import { ensureDir } from '../utils/file-utils.mjs';

const execFile = promisify(execFileCb);

/**
 * 判断是否应该为模板仓库 URL 注入 GitLab Token
 * @param {string} repoUrl 模板仓库 URL
 * @param {string} [gitlabHost] 配置的 GitLab 基础地址
 * @returns {boolean} 是否需要注入认证信息
 */
export function shouldAttachGitLabToken(repoUrl, gitlabHost = '') {
  if (!repoUrl) return false;
  try {
    const repoObj = new URL(repoUrl);
    const repoHostname = repoObj.hostname.toLowerCase();

    // 明确公开的第三方开源代码托管平台，严禁携带内网 GitLab Token
    if (
      repoHostname === 'github.com' ||
      repoHostname.endsWith('.github.com') ||
      repoHostname === 'gitee.com' ||
      repoHostname.endsWith('.gitee.com') ||
      repoHostname === 'gitlab.com'
    ) {
      return false;
    }

    // 若配置了 gitlabHost，且主机名匹配
    if (gitlabHost) {
      try {
        const gitlabHostObj = new URL(gitlabHost);
        if (repoHostname === gitlabHostObj.hostname.toLowerCase()) {
          return true;
        }
      } catch {
        // 忽略非标准 gitlabHost 解析异常
      }
    }

    // 纯内网 IPv4 地址或内部域名，且不是通用公网
    if (/^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(repoHostname)) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * 构建模板仓库 Clone/Fetch URL（防御性注入 GitLab Token）
 * @param {string} repoUrl 原始仓库 URL
 * @param {string} [token] 访问 Token
 * @param {string} [gitlabHost] GitLab Host
 * @returns {string} 可用的 Git URL
 */
export function buildAuthenticatedRepoUrl(repoUrl, token = '', gitlabHost = '') {
  if (!repoUrl || !token) return repoUrl;
  if (!shouldAttachGitLabToken(repoUrl, gitlabHost)) {
    return repoUrl;
  }
  try {
    const urlObj = new URL(repoUrl);
    urlObj.username = 'oauth2';
    urlObj.password = token;
    return urlObj.toString();
  } catch {
    return repoUrl;
  }
}

/**
 * 无窗口执行 Git 命令，避免 Windows 额外启动 cmd.exe。
 * @param {string[]} args Git 参数
 * @param {Record<string, unknown>} [options] 子进程选项
 * @returns {Promise<{stdout: string, stderr: string}>} Git 输出
 */
function runGit(args, options = {}) {
  return execFile('git', args, withHiddenWindow(options));
}

/**
 * 签出指定分支并包含 main 分支兜底机制
 * @param {string} targetBranch 期望分支名
 * @param {string} cwd 工作目录
 * @returns {Promise<string>} 最终签出的分支名
 */
async function checkoutBranchWithFallback(targetBranch, cwd) {
  try {
    await runGit(['checkout', '-B', targetBranch, `origin/${targetBranch}`], { cwd });
    return targetBranch;
  } catch (err) {
    if (targetBranch !== 'main') {
      console.warn(`[template-service] 签出分支 ${targetBranch} 失败，尝试回退到 main 分支...`);
      await runGit(['checkout', '-B', 'main', 'origin/main'], { cwd });
      return 'main';
    }
    throw err;
  }
}

/**
 * 拉取或更新模板仓库
 * @returns {Promise<boolean>} 是否成功
 */
export async function pullLatestTemplate() {
  try {
    // 检查模板目录是否存在
    try {
      await fs.stat(TEMPLATE_REPO_PATH);
      // 目录存在，执行更新操作；若因源变更或历史分叉更新失败，则重置重建
      try {
        return await updateExistingTemplate();
      } catch (updateError) {
        console.warn('[template-service] 更新已有模板失败，清理并重新克隆:', updateError.message);
        await fs.rm(TEMPLATE_REPO_PATH, { recursive: true, force: true });
        return await cloneTemplate();
      }
    } catch {
      // 目录不存在，执行克隆操作
      return await cloneTemplate();
    }
  } catch (e) {
    console.error('[template-service] 模板更新/克隆失败:', e);
    console.error('[template-service] 将使用现有模板（如果存在）');
    return false;
  }
}

/**
 * 更新已存在的模板仓库
 * @returns {Promise<boolean>} 是否成功
 */
async function updateExistingTemplate() {
  console.log(`[template-service] 更新模板仓库: ${TEMPLATE_REPO_PATH}`);

  const targetUrl = buildAuthenticatedRepoUrl(TEMPLATE_REPO_URL, GITLAB_TOKEN, GITLAB_HOST);

  // 检查并更新 remote origin URL
  try {
    const { stdout: currentRemote } = await runGit(['remote', 'get-url', 'origin'], { cwd: TEMPLATE_REPO_PATH }).catch(() => ({ stdout: '' }));
    if (currentRemote.trim() !== targetUrl) {
      await runGit(['remote', 'set-url', 'origin', targetUrl], { cwd: TEMPLATE_REPO_PATH }).catch(async () => {
        await runGit(['remote', 'remove', 'origin'], { cwd: TEMPLATE_REPO_PATH }).catch(() => {});
        await runGit(['remote', 'add', 'origin', targetUrl], { cwd: TEMPLATE_REPO_PATH });
      });
      console.log('[template-service] 已更新 git remote origin URL');
    }
  } catch (urlError) {
    console.warn('[template-service] 无法更新 remote URL，尝试重置:', urlError.message);
    await runGit(['remote', 'remove', 'origin'], { cwd: TEMPLATE_REPO_PATH }).catch(() => {});
    await runGit(['remote', 'add', 'origin', targetUrl], { cwd: TEMPLATE_REPO_PATH });
  }

  // 使用 fetch origin 获取远端全部更新，以保证目标分支与 fallback 分支均可用
  const { stdout: fetchOut, stderr: fetchErr } = await runGit(
    ['fetch', 'origin'],
    { cwd: TEMPLATE_REPO_PATH },
  );
  if (fetchOut) console.log('[template-service] git fetch stdout:', fetchOut);
  if (fetchErr) console.log('[template-service] git fetch stderr:', fetchErr);

  // 签出目标分支（支持 main 回退）
  const activeBranch = await checkoutBranchWithFallback(TEMPLATE_BRANCH, TEMPLATE_REPO_PATH);

  const { stdout: resetOut, stderr: resetErr } = await runGit(
    ['reset', '--hard', `origin/${activeBranch}`],
    { cwd: TEMPLATE_REPO_PATH },
  );
  if (resetOut) console.log('[template-service] git reset stdout:', resetOut);
  if (resetErr) console.log('[template-service] git reset stderr:', resetErr);

  const { stdout: cleanOut, stderr: cleanErr } = await runGit(['clean', '-fd'], { cwd: TEMPLATE_REPO_PATH });
  if (cleanOut) console.log('[template-service] git clean stdout:', cleanOut);
  if (cleanErr) console.log('[template-service] git clean stderr:', cleanErr);

  console.log('[template-service] ✅ 模板更新成功');
  return true;
}

/**
 * 克隆模板仓库
 * @returns {Promise<boolean>} 是否成功
 */
async function cloneTemplate() {
  console.log(`[template-service] 克隆模板仓库到: ${TEMPLATE_REPO_PATH}`);

  const parentDir = path.dirname(TEMPLATE_REPO_PATH);
  await ensureDir(parentDir);

  const cloneUrl = buildAuthenticatedRepoUrl(TEMPLATE_REPO_URL, GITLAB_TOKEN, GITLAB_HOST);

  // 克隆仓库
  const { stdout: cloneOut, stderr: cloneErr } = await runGit(['clone', cloneUrl, TEMPLATE_REPO_PATH]);
  if (cloneOut) console.log('[template-service] git clone stdout:', cloneOut);
  if (cloneErr) console.log('[template-service] git clone stderr:', cloneErr);

  // checkout 到指定分支（支持 main 回退）
  const activeBranch = await checkoutBranchWithFallback(TEMPLATE_BRANCH, TEMPLATE_REPO_PATH);

  // 确保工作树是最新的
  const { stdout: resetOut, stderr: resetErr } = await runGit(
    ['reset', '--hard', `origin/${activeBranch}`],
    { cwd: TEMPLATE_REPO_PATH },
  );
  if (resetOut) console.log('[template-service] git reset stdout:', resetOut);
  if (resetErr) console.log('[template-service] git reset stderr:', resetErr);

  console.log('[template-service] ✅ 模板克隆成功');
  return true;
}

/**
 * 验证模板脚本是否存在
 * @returns {Promise<boolean>} 脚本是否存在
 */
export async function validateTemplate() {
  const scriptPath = path.join(TEMPLATE_REPO_PATH, 'scripts', 'create-microapp.mjs');
  try {
    await fs.stat(scriptPath);
    console.log('[template-service] ✓ 模板脚本已就绪:', scriptPath);
    return true;
  } catch {
    console.error('[template-service] ✗ 模板脚本不存在:', scriptPath);
    return false;
  }
}

/**
 * 获取模板脚本路径
 * @returns {string} 脚本绝对路径
 */
export function getTemplateScriptPath() {
  return path.join(TEMPLATE_REPO_PATH, 'scripts', 'create-microapp.mjs');
}
