#!/usr/bin/env node
/**
 * scripts/verify-ci-status.mjs
 *
 * 发版前智能状态守门脚本（对标 yss-ui）：
 * 1. 检查当前待发版 Commit 在 GitHub 上的 "CI / CD Pipeline"（ci.yml）运行状态；
 * 2. 若 CI 正在运行（in_progress / queued），自动每隔一段时间轮询等待其完成，无需人工反复刷新；
 * 3. 若 CI 成功（success），秒级放行，进入桌面端构建与发版流程；
 * 4. 若 CI 失败（failure / cancelled），立即拦截并报错退出，坚决防止发布未经质量门禁验证的产物。
 */

import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * 获取当前本地仓库 HEAD 的 Git Commit SHA。
 * @returns {string} 完整的 40 位 Commit SHA
 */
export function getGitSha() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * 延迟指定毫秒。
 * @param {number} ms 等待时间（毫秒）
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 从 GitHub API 拉取指定 commit SHA 对应的 workflow 运行列表。
 * @param {{ repo: string; targetSha: string; token?: string; fetchFn?: typeof fetch }} options
 * @returns {Promise<Array<object>>} workflow 运行记录数组
 */
export async function fetchWorkflowRuns({ repo, targetSha, token, fetchFn = fetch }) {
  const url = `https://api.github.com/repos/${repo}/actions/runs?head_sha=${targetSha}&per_page=20`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'yuyan-app-ci-verifier',
  };
  if (token && token.trim() !== '') {
    headers.Authorization = `Bearer ${token.trim()}`;
  }

  const res = await fetchFn(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API 响应异常: HTTP ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data.workflow_runs || [];
}

/**
 * 校验目标 Commit SHA 的 CI 门禁状态。
 * @param {object} options
 * @param {string} [options.targetSha] 待验证的 Git SHA
 * @param {string} [options.repo] GitHub 仓库名称（例如 "ycwang-dev/yuyan"）
 * @param {string} [options.token] GitHub Token
 * @param {number} [options.maxWaitSeconds=900] 最长等待时间（秒，默认 15 分钟）
 * @param {number} [options.pollIntervalMs=15000] 轮询间隔（毫秒，默认 15 秒）
 * @param {typeof fetch} [options.fetchFn=fetch] 用于网络请求的 fetch 函数
 * @param {(msg: string) => void} [options.logger=console.log] 日志打印函数
 * @returns {Promise<{ success: boolean; run?: object; message?: string }>} 校验结果
 */
export async function verifyCiStatus({
  targetSha = process.env.TARGET_SHA || process.env.GITHUB_SHA || getGitSha(),
  repo = process.env.GITHUB_REPOSITORY || 'ycwang-dev/yuyan',
  token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  maxWaitSeconds = parseInt(process.env.MAX_WAIT_SECONDS || '900', 10),
  pollIntervalMs = 15000,
  fetchFn = fetch,
  logger = (msg) => console.log(`[verify-ci] ${msg}`),
} = {}) {
  if (!targetSha) {
    throw new Error('未指定待验证的目标 Commit SHA (TARGET_SHA)');
  }

  logger(`待验证 Commit: ${targetSha.slice(0, 7)} (${targetSha})`);
  logger(`目标仓库: ${repo}`);

  if (!token) {
    logger('⚠️ 未检测到 GITHUB_TOKEN，将使用无鉴权模式调用 GitHub API（注意公共调用速率限制）。');
  }

  const startTime = Date.now();
  let notFoundCount = 0;

  while (true) {
    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    if (elapsedSeconds > maxWaitSeconds) {
      const msg = `❌ 等待前置 CI 超时（已超过 ${maxWaitSeconds} 秒），发版流程自动终止！`;
      logger(msg);
      return { success: false, message: msg };
    }

    let runs = [];
    try {
      runs = await fetchWorkflowRuns({ repo, targetSha, token, fetchFn });
    } catch (err) {
      logger(`⚠️ 抓取 workflow 状态失败，稍后重试: ${err.message}`);
      await sleep(pollIntervalMs);
      continue;
    }

    // 匹配当前 commit 上的 CI 质量流水线（名称为 "CI / CD Pipeline" 或路径以 ci.yml 结尾）
    const ciRuns = runs.filter((r) => r.name === 'CI / CD Pipeline' || (r.path && r.path.endsWith('ci.yml')));

    if (ciRuns.length === 0) {
      notFoundCount += 1;
      if (notFoundCount > 6) {
        logger('⚠️ 未在当前 Commit 上检索到 CI 门禁（ci.yml）记录。');
        logger('可能此 Commit 未触发 CI 或处于调度队列最前端，将继续等待...');
      } else {
        logger(`⏳ 正在检索当前 Commit 的 CI 运行记录... (尝试 ${notFoundCount})`);
      }
      await sleep(pollIntervalMs);
      continue;
    }

    // 取最新的一条 CI run
    const latestCiRun = ciRuns.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
    const { status, conclusion, html_url, id } = latestCiRun;

    if (status === 'completed') {
      if (conclusion === 'success') {
        logger(`🎉 前置 CI 质量检查全部通过！`);
        logger(`Run ID: ${id} | 详情查看: ${html_url}`);
        logger(`耗时等待: ${elapsedSeconds}s，立即进入桌面端构建与发版流程！`);
        return { success: true, run: latestCiRun };
      }

      const msg = `❌ 严正拦截：前置 CI 执行结果为 [${conclusion}]！\n详情日志: ${html_url}\n请先修复 CI 错误并重新构建成功后再进行发版，已自动终止发包。`;
      logger(msg);
      return { success: false, run: latestCiRun, message: msg };
    }

    logger(`⏳ 检测到前置 CI 正在运行 (状态: ${status})...`);
    logger(`⏳ 详情: ${html_url}`);
    logger(`⏳ 自动等待前置完成中... (已等待 ${elapsedSeconds}s / 上限 ${maxWaitSeconds}s)`);
    await sleep(pollIntervalMs);
  }
}

/**
 * CLI 命令行入口执行。
 */
async function main() {
  const result = await verifyCiStatus();
  if (!result.success) {
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[verify-ci] 发生未捕获异常:', err);
    process.exit(1);
  });
}
