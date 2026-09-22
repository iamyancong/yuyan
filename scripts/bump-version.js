import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * 解析 SemVer 字符串为数字三元组 [major, minor, patch]。
 * @param {string} version 版本号（例如 "1.3.0"）
 * @returns {[number, number, number]}
 */
export function parseSemVer(version) {
  const clean = String(version).trim().replace(/^v/, '');
  const match = clean.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return [0, 0, 0];
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * 比较两个语义化版本号。
 * @param {string} v1 第一个版本号
 * @param {string} v2 第二个版本号
 * @returns {number} 1 (v1 > v2), -1 (v1 < v2), 0 (v1 == v2)
 */
export function compareSemVer(v1, v2) {
  const [maj1, min1, pat1] = parseSemVer(v1);
  const [maj2, min2, pat2] = parseSemVer(v2);
  if (maj1 !== maj2) return maj1 > maj2 ? 1 : -1;
  if (min1 !== min2) return min1 > min2 ? 1 : -1;
  if (pat1 !== pat2) return pat1 > pat2 ? 1 : -1;
  return 0;
}

/**
 * 根据指定递增类型计算下一版本号。
 * @param {object} options
 * @param {string} options.baseVersion 基准版本号（如 "1.3.0"）
 * @param {'patch' | 'minor' | 'major'} [options.bumpType='patch'] 递增类型
 * @returns {string} 计算出的新版本号
 */
export function calculateNextVersion({ baseVersion, bumpType = 'patch' }) {
  const [major, minor, patch] = parseSemVer(baseVersion);
  switch (bumpType) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
    default:
      return `${major}.${minor}.${patch + 1}`;
  }
}

/**
 * 从 GitHub Releases API 获取仓库最新的正式语义化版本号。
 * @param {object} options
 * @param {string} options.repo 仓库名称（例如 "ycwang-dev/yuyan"）
 * @param {string} [options.token] GitHub Token
 * @param {typeof fetch} [options.fetchFn=fetch]
 * @returns {Promise<string>} 最新版本号，未找到则返回 "0.0.0"
 */
export async function fetchLatestReleaseVersion({ repo, token, fetchFn = fetch }) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'yuyan-app-version-bumper',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token && token.trim() !== '') {
    headers.Authorization = `Bearer ${token.trim()}`;
  }

  try {
    const res = await fetchFn(`https://api.github.com/repos/${repo}/releases`, { headers });
    if (!res.ok) {
      console.warn(`[bump-version] 无法拉取 releases 列表: HTTP ${res.status} ${res.statusText}`);
      return '0.0.0';
    }
    const releases = await res.json();
    if (Array.isArray(releases)) {
      for (const rel of releases) {
        const tag = rel.tag_name || '';
        // 只匹配标准语义化版本 tag，如 v1.2.3 或 1.2.3
        const match = tag.match(/^v?(\d+\.\d+\.\d+)$/);
        if (match) {
          return match[1];
        }
      }
    }
  } catch (err) {
    console.warn(`[bump-version] 获取 releases 出现网络异常: ${err.message}`);
  }
  return '0.0.0';
}

/**
 * 提取自上一个 Release Tag 以来的 Git 提交记录，用于生成 Release Notes。
 * @param {object} [options]
 * @param {string} [options.prevTag] 上一个 Git Tag
 * @param {string} [options.customNotes] 用户手动指定的补充说明
 * @returns {string} 格式化后的 Markdown 变更日志
 */
export function getGitChangelog({ prevTag, customNotes } = {}) {
  const notes = [];
  if (customNotes && customNotes.trim() !== '') {
    notes.push(customNotes.trim(), '');
  }

  let range = 'HEAD';
  if (prevTag) {
    range = `${prevTag}..HEAD`;
  } else {
    try {
      const detectedTag = execSync('git describe --tags --abbrev=0 2>/dev/null', { encoding: 'utf8' }).trim();
      if (detectedTag) {
        range = `${detectedTag}..HEAD`;
      }
    } catch {
      range = '-n 15 HEAD';
    }
  }

  try {
    const gitLogCmd = range.startsWith('-n')
      ? `git log ${range} --no-merges --pretty=format:"* %s (%h)"`
      : `git log ${range} --no-merges --pretty=format:"* %s (%h)"`;
    const commits = execSync(gitLogCmd, { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !s.includes('chore(release): bump version'));

    if (commits.length > 0) {
      notes.push('### 变更内容 (Commits)', ...commits);
    } else {
      notes.push('### 变更内容', '* 日常功能优化与稳定性提升');
    }
  } catch {
    notes.push('### 变更内容', '* 桌面端功能优化与依赖更新');
  }

  return notes.join('\n');
}

/**
 * 解析并生成完整的发版计划（版本号、Tag、Release Notes、Dry-run 等）。
 * @param {object} options
 * @param {string} [options.tauriConfigPath='src-tauri/tauri.conf.json']
 * @param {string} [options.githubRef]
 * @param {string} [options.bumpType='patch']
 * @param {boolean} [options.dryRun=false]
 * @param {boolean} [options.prerelease=false]
 * @param {string} [options.customNotes='']
 * @param {string} [options.repo]
 * @param {string} [options.token]
 * @param {typeof fetch} [options.fetchFn]
 * @returns {Promise<{ version: string; tag: string; prerelease: boolean; dry_run: boolean; release_notes: string }>}
 */
export async function resolveReleasePlan({
  tauriConfigPath = path.resolve('src-tauri/tauri.conf.json'),
  githubRef = process.env.GITHUB_REF || '',
  bumpType = process.env.BUMP || 'patch',
  dryRun = process.env.DRY_RUN === 'true',
  prerelease = process.env.PRERELEASE === 'true',
  customNotes = process.env.CUSTOM_NOTES || '',
  repo = process.env.GITHUB_REPOSITORY || 'ycwang-dev/yuyan',
  token = process.env.GITHUB_TOKEN,
  fetchFn = fetch,
} = {}) {
  // 1. 如果是推送 Tag 触发（例如 refs/tags/v1.3.0），直接使用 Tag 里的版本，不进行二次 bump
  if (githubRef.startsWith('refs/tags/')) {
    const rawTag = githubRef.replace('refs/tags/', '');
    const version = rawTag.replace(/^v/, '');
    console.log(`[bump-version] 由 Tag (${rawTag}) 触发，直接使用版本号: ${version}`);
    const releaseNotes = getGitChangelog({ customNotes });
    return {
      version,
      tag: `v${version}`,
      prerelease,
      dry_run: dryRun,
      release_notes: releaseNotes,
    };
  }

  // 2. 读取本地 tauri.conf.json 版本
  if (!fs.existsSync(tauriConfigPath)) {
    throw new Error(`未找到 Tauri 配置文件: ${tauriConfigPath}`);
  }
  const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));
  const localVersion = tauriConfig.version || '0.0.0';

  // 3. 读取线上最新的 Release 版本
  const latestOnlineVersion = await fetchLatestReleaseVersion({ repo, token, fetchFn });

  // 4. 计算基准版本：取本地版本与线上版本中的较大者
  const baseVersion = compareSemVer(localVersion, latestOnlineVersion) > 0 ? localVersion : latestOnlineVersion;

  // 5. 根据 bump 类型计算下一版本
  const targetVersion = calculateNextVersion({ baseVersion, bumpType });

  console.log(`[bump-version] 版本推算: 基准版本 ${baseVersion} (本地: ${localVersion}, 线上最新: ${latestOnlineVersion}) -> 下一版本 ${targetVersion} [${bumpType}]`);
  if (dryRun) {
    console.log(`[bump-version] ⚠️ 当前处于 dry-run 预览模式，不会真正创建 Release 或推送 commit。`);
  }

  const releaseNotes = getGitChangelog({ customNotes });

  return {
    version: targetVersion,
    tag: `v${targetVersion}`,
    prerelease,
    dry_run: dryRun,
    release_notes: releaseNotes,
  };
}

/**
 * 解析 CLI 命令行参数。
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = {
    bumpType: 'patch',
    dryRun: false,
    prerelease: false,
    customNotes: '',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--bump' && argv[i + 1]) {
      args.bumpType = argv[++i];
    } else if (arg.startsWith('--bump=')) {
      args.bumpType = arg.slice(arg.indexOf('=') + 1);
    } else if (arg === '--dry-run' || arg === '--dry_run') {
      const next = argv[i + 1];
      if (next === 'true' || next === 'false') {
        args.dryRun = next === 'true';
        i++;
      } else {
        args.dryRun = true;
      }
    } else if (arg.startsWith('--dry-run=') || arg.startsWith('--dry_run=')) {
      args.dryRun = arg.slice(arg.indexOf('=') + 1) === 'true';
    } else if (arg === '--prerelease') {
      const next = argv[i + 1];
      if (next === 'true' || next === 'false') {
        args.prerelease = next === 'true';
        i++;
      } else {
        args.prerelease = true;
      }
    } else if (arg.startsWith('--prerelease=')) {
      args.prerelease = arg.slice(arg.indexOf('=') + 1) === 'true';
    } else if (arg === '--notes' && argv[i + 1]) {
      args.customNotes = argv[++i];
    } else if (arg.startsWith('--notes=')) {
      args.customNotes = arg.slice(arg.indexOf('=') + 1);
    }
  }

  return args;
}

/**
 * 主执行函数。
 */
async function main() {
  const cliArgs = parseArgs();
  const plan = await resolveReleasePlan({
    bumpType: cliArgs.bumpType || process.env.BUMP || 'patch',
    dryRun: cliArgs.dryRun || process.env.DRY_RUN === 'true',
    prerelease: cliArgs.prerelease || process.env.PRERELEASE === 'true',
    customNotes: cliArgs.customNotes || process.env.CUSTOM_NOTES || '',
  });

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    fs.appendFileSync(githubOutput, `version=${plan.version}\n`);
    fs.appendFileSync(githubOutput, `tag=${plan.tag}\n`);
    fs.appendFileSync(githubOutput, `prerelease=${plan.prerelease}\n`);
    fs.appendFileSync(githubOutput, `dry_run=${plan.dry_run}\n`);

    // 多行输出 Release Notes
    const delimiter = `EOF_${Date.now()}`;
    fs.appendFileSync(githubOutput, `release_notes<<${delimiter}\n${plan.release_notes}\n${delimiter}\n`);
  }

  console.log(`[bump-version] 计算结果: version=${plan.version}, tag=${plan.tag}, dry_run=${plan.dry_run}, prerelease=${plan.prerelease}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[bump-version] 执行异常:', err);
    process.exit(1);
  });
}
