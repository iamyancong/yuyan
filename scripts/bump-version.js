import fs from 'fs';
import path from 'path';

async function getNextVersion() {
  const tauriConfigPath = path.resolve('src-tauri/tauri.conf.json');
  if (!fs.existsSync(tauriConfigPath)) {
    throw new Error(`File not found: ${tauriConfigPath}`);
  }
  const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));
  const localVersion = tauriConfig.version; // 本地版本号（例如 "1.0.0"）

  const githubRef = process.env.GITHUB_REF || '';
  // 1. 如果是手动推送的 tag (v*) 触发，直接使用该 tag 版本
  if (githubRef.startsWith('refs/tags/')) {
    const tag = githubRef.replace('refs/tags/', '');
    const version = tag.replace(/^v/, '');
    console.log(`Triggered by tag push. Using tag version: ${version}`);
    return {
      version,
      tag: `v${version}`,
      prerelease: false
    };
  }

  // 2. 如果是分支推送触发，获取 GitHub Releases 列表，寻找最新的正式版本号
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'yuyan-app',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token && token.trim() !== '') {
    headers['Authorization'] = `Bearer ${token.trim()}`;
  }

  let latestVersion = '0.0.0';
  try {
    const repo = process.env.GITHUB_REPOSITORY || 'ycwang-dev/yuyan';
    const res = await fetch(`https://api.github.com/repos/${repo}/releases`, { headers });
    if (res.ok) {
      const releases = await res.json();
      if (Array.isArray(releases)) {
        for (const rel of releases) {
          const tag = rel.tag_name;
          // 只匹配干净的语义化版本号，例如 v1.0.0 或 1.0.0，跳过带 hash 后缀的旧 tag
          const match = tag.match(/^v?(\d+\.\d+\.\d+)$/);
          if (match) {
            latestVersion = match[1];
            break;
          }
        }
      }
    } else {
      console.warn(`Failed to fetch releases: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    console.warn(`Error fetching releases: ${err.message}`);
  }

  const localParts = localVersion.split('.').map(Number);
  const latestParts = latestVersion.split('.').map(Number);

  let targetVersion = localVersion;
  let isGreater = false;
  for (let i = 0; i < 3; i++) {
    const localNum = localParts[i] || 0;
    const latestNum = latestParts[i] || 0;
    if (localNum > latestNum) {
      isGreater = true;
      break;
    } else if (latestNum > localNum) {
      break;
    }
  }

  // 如果本地配置的版本（如 1.0.0）不大于线上已有的最新 tag（如 1.0.0 或 1.0.1）
  // 说明需要将线上最新版本进行 patch 递增
  if (!isGreater) {
    const major = latestParts[0] || 1;
    const minor = latestParts[1] || 0;
    const patch = (latestParts[2] || 0) + 1;
    targetVersion = `${major}.${minor}.${patch}`;
  }

  console.log(`Determined next version: ${targetVersion} (local: ${localVersion}, latest: ${latestVersion})`);
  return {
    version: targetVersion,
    tag: `v${targetVersion}`,
    prerelease: true
  };
}

getNextVersion().then(({ version, tag, prerelease }) => {
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    fs.appendFileSync(githubOutput, `version=${version}\n`);
    fs.appendFileSync(githubOutput, `tag=${tag}\n`);
    fs.appendFileSync(githubOutput, `prerelease=${prerelease}\n`);
  }
}).catch(err => {
  console.error(err);
  process.exit(1);
});
