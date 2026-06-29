/**
 * 模板仓库管理服务
 * @description 负责拉取和更新前端模板仓库
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { TEMPLATE_REPO_PATH, TEMPLATE_REPO_URL, TEMPLATE_BRANCH, GITLAB_TOKEN } from '../config/constants.mjs';
import { ensureDir } from '../utils/file-utils.mjs';

const exec = promisify(execCb);

/**
 * 拉取或更新模板仓库
 * @returns {Promise<boolean>} 是否成功
 */
export async function pullLatestTemplate() {
  if (!TEMPLATE_REPO_URL) {
    console.warn('[template-service] TEMPLATE_REPO_URL 未配置，跳过模板仓库更新/克隆。');
    return false;
  }
  try {
    // 检查模板目录是否存在
    try {
      await fs.stat(TEMPLATE_REPO_PATH);
      // 目录存在，执行更新操作
      return await updateExistingTemplate();
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

  // 更新 remote URL 以支持认证
  if (GITLAB_TOKEN) {
    try {
      const urlObj = new URL(TEMPLATE_REPO_URL);
      urlObj.username = 'oauth2';
      urlObj.password = GITLAB_TOKEN;
      const authUrl = urlObj.toString();

      await exec('git remote remove origin', { cwd: TEMPLATE_REPO_PATH }).catch(() => {});
      await exec(`git remote add origin ${authUrl}`, { cwd: TEMPLATE_REPO_PATH });
      console.log('[template-service] 已更新 git remote URL (带认证)');
    } catch (urlError) {
      console.warn('[template-service] 无法更新 remote URL，使用原始配置:', urlError.message);
    }
  }

  // 使用 fetch + reset 方式更新（比 pull 更可靠）
  const { stdout: fetchOut, stderr: fetchErr } = await exec(`git fetch origin ${TEMPLATE_BRANCH}`, { cwd: TEMPLATE_REPO_PATH });
  if (fetchOut) console.log('[template-service] git fetch stdout:', fetchOut);
  if (fetchErr) console.log('[template-service] git fetch stderr:', fetchErr);

  const { stdout: resetOut, stderr: resetErr } = await exec(`git reset --hard origin/${TEMPLATE_BRANCH}`, { cwd: TEMPLATE_REPO_PATH });
  if (resetOut) console.log('[template-service] git reset stdout:', resetOut);
  if (resetErr) console.log('[template-service] git reset stderr:', resetErr);

  const { stdout: cleanOut, stderr: cleanErr } = await exec('git clean -fd', { cwd: TEMPLATE_REPO_PATH });
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

  // 构建带认证的 URL（如果提供了 token）
  let cloneUrl = TEMPLATE_REPO_URL;
  if (GITLAB_TOKEN) {
    try {
      const urlObj = new URL(TEMPLATE_REPO_URL);
      urlObj.username = 'oauth2';
      urlObj.password = GITLAB_TOKEN;
      cloneUrl = urlObj.toString();
    } catch {
      console.log('[template-service] 无法解析模板仓库 URL，使用原始 URL');
    }
  }

  // 克隆仓库
  const { stdout: cloneOut, stderr: cloneErr } = await exec(`git clone "${cloneUrl}" "${TEMPLATE_REPO_PATH}"`);
  if (cloneOut) console.log('[template-service] git clone stdout:', cloneOut);
  if (cloneErr) console.log('[template-service] git clone stderr:', cloneErr);

  // checkout 到指定分支
  const { stdout: checkoutOut, stderr: checkoutErr } = await exec(`git checkout ${TEMPLATE_BRANCH}`, { cwd: TEMPLATE_REPO_PATH });
  if (checkoutOut) console.log('[template-service] git checkout stdout:', checkoutOut);
  if (checkoutErr) console.log('[template-service] git checkout stderr:', checkoutErr);

  // 确保工作树是最新的
  const { stdout: resetOut, stderr: resetErr } = await exec(`git reset --hard origin/${TEMPLATE_BRANCH}`, { cwd: TEMPLATE_REPO_PATH });
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
