import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildPnpmToolchainEnv,
  commandsUsePnpm,
  parsePackageManagerSpec,
  resolveFrontendToolchain,
  resolvePnpmPrefixLayout,
} from '../frontend-toolchain-service.mjs';

/**
 * 在指定 prefix 目录下创建一个模拟的 pnpm 可执行文件。
 * @param {string} prefixDir - prefix 目录
 * @param {NodeJS.Platform} [platform=process.platform] - 平台
 * @returns {Promise<{ binDir: string, binPath: string }>}
 */
async function createFakePnpmBinary(prefixDir, platform = process.platform) {
  const layout = resolvePnpmPrefixLayout(prefixDir, platform);
  await fs.mkdir(layout.binDir, { recursive: true });
  await fs.writeFile(layout.binPath, '#!/bin/sh\necho fake-pnpm\n', { mode: 0o755 });
  return layout;
}

test('parsePackageManagerSpec 正确解析精确版本并拒绝范围或注入字符串', () => {
  assert.deepEqual(parsePackageManagerSpec('pnpm@10.15.0'), {
    name: 'pnpm',
    version: '10.15.0',
    raw: 'pnpm@10.15.0',
  });
  assert.deepEqual(parsePackageManagerSpec('pnpm@9.15.9+sha512.68046141893c66fa'), {
    name: 'pnpm',
    version: '9.15.9',
    raw: 'pnpm@9.15.9+sha512.68046141893c66fa',
  });
  assert.deepEqual(parsePackageManagerSpec('pnpm@10.15.0-rc.1'), {
    name: 'pnpm',
    version: '10.15.0-rc.1',
    raw: 'pnpm@10.15.0-rc.1',
  });
  assert.equal(parsePackageManagerSpec('pnpm@^10.15.0'), null);
  assert.equal(parsePackageManagerSpec('pnpm@latest'), null);
  assert.equal(parsePackageManagerSpec('pnpm@10.15.0;rm -rf /'), null);
  assert.equal(parsePackageManagerSpec('pnpm@../../etc'), null);
  assert.equal(parsePackageManagerSpec('unknown@1.0.0'), null);
  assert.equal(parsePackageManagerSpec(''), null);
});

test('commandsUsePnpm 精准识别 pnpm 命令且不误伤 yarn/npm', () => {
  assert.equal(commandsUsePnpm('pnpm install', 'pnpm build'), true);
  assert.equal(commandsUsePnpm('', 'cd packages && pnpm build'), true);
  assert.equal(commandsUsePnpm('corepack pnpm install', ''), true);
  assert.equal(commandsUsePnpm('yarn install', 'yarn build'), false);
  assert.equal(commandsUsePnpm('npm ci', 'npm run build'), false);
  assert.equal(commandsUsePnpm('my-pnpm-wrapper install', 'vite build'), false);
});

test('resolveFrontendToolchain 非 pnpm 项目直接跳过，不改环境变量', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-toolchain-skip-'));
  try {
    const res = await resolveFrontendToolchain({
      repoDir: tmpDir,
      installCommand: 'yarn install',
      buildCommand: 'yarn build',
    });
    assert.equal(res.managed, false);
    assert.equal(res.source, 'none');
    assert.deepEqual(res.env, {});
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('resolveFrontendToolchain 命中 L1 镜像预置池并前置 PATH 且关闭 pnpm 自下载', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-toolchain-l1-'));
  try {
    const repoDir = path.join(tmpDir, 'repo');
    const preinstalledRoot = path.join(tmpDir, 'preinstalled');
    const cacheRoot = path.join(tmpDir, 'cache');
    await fs.mkdir(repoDir, { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'package.json'),
      JSON.stringify({ name: 'microapp', packageManager: 'pnpm@10.15.0' })
    );
    const l1Layout = await createFakePnpmBinary(path.join(preinstalledRoot, 'pnpm', '10.15.0'), 'linux');

    const logs = [];
    const res = await resolveFrontendToolchain({
      repoDir,
      installCommand: 'pnpm install',
      buildCommand: 'pnpm build',
      preinstalledRoot,
      cacheRoot,
      platform: 'linux',
      basePath: '/usr/local/bin:/usr/bin',
      log: (level, message, stage) => logs.push({ level, message, stage }),
      probeHostVersionFn: async () => {
        throw new Error('命中 L1 时不应探测宿主机');
      },
      installPackageFn: async () => {
        throw new Error('命中 L1 时不应触发安装');
      },
    });

    assert.equal(res.managed, true);
    assert.equal(res.version, '10.15.0');
    assert.equal(res.declaredByRepo, true);
    assert.equal(res.source, 'preinstalled');
    assert.equal(res.binDir, l1Layout.binDir);
    assert.equal(res.env.PATH, `${l1Layout.binDir}:/usr/local/bin:/usr/bin`);
    assert.equal(res.env.npm_config_manage_package_manager_versions, 'false');
    assert.equal(logs.some((item) => item.message.includes('命中镜像预置工具链')), true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('resolveFrontendToolchain 未声明 packageManager 时默认命中预置 9.15.9 保障老项目零回归', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-toolchain-default-'));
  try {
    const repoDir = path.join(tmpDir, 'repo');
    const preinstalledRoot = path.join(tmpDir, 'preinstalled');
    const cacheRoot = path.join(tmpDir, 'cache');
    await fs.mkdir(repoDir, { recursive: true });
    await fs.writeFile(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'legacy-app' }));
    const l1Layout = await createFakePnpmBinary(path.join(preinstalledRoot, 'pnpm', '9.15.9'), 'linux');

    const res = await resolveFrontendToolchain({
      repoDir,
      installCommand: 'pnpm install',
      buildCommand: 'pnpm build',
      preinstalledRoot,
      cacheRoot,
      platform: 'linux',
      basePath: '/usr/bin',
    });

    assert.equal(res.version, '9.15.9');
    assert.equal(res.declaredByRepo, false);
    assert.equal(res.source, 'preinstalled');
    assert.equal(res.binDir, l1Layout.binDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('resolveFrontendToolchain 命中 L2 持久化缓存池', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-toolchain-l2-hit-'));
  try {
    const repoDir = path.join(tmpDir, 'repo');
    const preinstalledRoot = path.join(tmpDir, 'preinstalled');
    const cacheRoot = path.join(tmpDir, 'cache');
    await fs.mkdir(repoDir, { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'package.json'),
      JSON.stringify({ name: 'app', packageManager: 'pnpm@10.20.0' })
    );
    const l2Layout = await createFakePnpmBinary(path.join(cacheRoot, 'pnpm', '10.20.0'), 'linux');

    const res = await resolveFrontendToolchain({
      repoDir,
      installCommand: 'pnpm install',
      preinstalledRoot,
      cacheRoot,
      platform: 'linux',
      basePath: '/usr/bin',
    });

    assert.equal(res.source, 'cached');
    assert.equal(res.version, '10.20.0');
    assert.equal(res.env.PATH, `${l2Layout.binDir}:/usr/bin`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('resolveFrontendToolchain L2 按需安装复用运行时 .npmrc 并具备并发单飞去重能力', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-toolchain-l2-install-'));
  try {
    const repoDir = path.join(tmpDir, 'repo');
    const preinstalledRoot = path.join(tmpDir, 'preinstalled');
    const cacheRoot = path.join(tmpDir, 'cache');
    const runtimeNpmrc = path.join(repoDir, '.yuyan.npmrc');
    await fs.mkdir(repoDir, { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'package.json'),
      JSON.stringify({ name: 'future-app', packageManager: 'pnpm@10.22.0' })
    );
    await fs.writeFile(runtimeNpmrc, 'registry=http://nexus.corp.local/repository/npm-group/\n');

    let installCallCount = 0;
    let capturedNpmrc = '';
    const installPackageFn = async ({ version, prefixDir, npmrcPath, platform }) => {
      installCallCount += 1;
      capturedNpmrc = npmrcPath;
      assert.equal(version, '10.22.0');
      await new Promise((r) => setTimeout(r, 40));
      await createFakePnpmBinary(prefixDir, platform);
    };

    const [r1, r2] = await Promise.all([
      resolveFrontendToolchain({
        repoDir,
        installCommand: 'pnpm install',
        runtimeEnv: { NPM_CONFIG_USERCONFIG: runtimeNpmrc },
        preinstalledRoot,
        cacheRoot,
        platform: 'linux',
        basePath: '/usr/bin',
        probeHostVersionFn: async () => '9.15.9',
        installPackageFn,
      }),
      resolveFrontendToolchain({
        repoDir,
        installCommand: 'pnpm install',
        runtimeEnv: { NPM_CONFIG_USERCONFIG: runtimeNpmrc },
        preinstalledRoot,
        cacheRoot,
        platform: 'linux',
        basePath: '/usr/bin',
        probeHostVersionFn: async () => '9.15.9',
        installPackageFn,
      }),
    ]);

    assert.equal(installCallCount, 1, '同版本并发发布只应触发一次安装');
    assert.equal(capturedNpmrc, runtimeNpmrc, '应优先复用雨燕运行时私服 .npmrc');
    assert.equal(r1.version, '10.22.0');
    assert.equal(r2.version, '10.22.0');
    assert.deepEqual([r1.source, r2.source].sort(), ['cached', 'installed']);

    const expectedLayout = resolvePnpmPrefixLayout(path.join(cacheRoot, 'pnpm', '10.22.0'), 'linux');
    assert.equal(r1.binDir, expectedLayout.binDir);
    assert.equal(r2.binDir, expectedLayout.binDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('resolveFrontendToolchain 禁用自动安装或安装失败时安全回退宿主机并保留防护变量', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-toolchain-fallback-'));
  try {
    const repoDir = path.join(tmpDir, 'repo');
    await fs.mkdir(repoDir, { recursive: true });
    await fs.writeFile(
      path.join(repoDir, 'package.json'),
      JSON.stringify({ name: 'airgap-app', packageManager: 'pnpm@10.99.0' })
    );

    const disabledRes = await resolveFrontendToolchain({
      repoDir,
      installCommand: 'pnpm install',
      preinstalledRoot: path.join(tmpDir, 'preinstalled'),
      cacheRoot: path.join(tmpDir, 'cache'),
      allowAutoInstall: false,
      probeHostVersionFn: async () => '9.15.9',
      installPackageFn: async () => {
        throw new Error('不应调用安装');
      },
    });
    assert.equal(disabledRes.source, 'fallback');
    assert.equal(disabledRes.version, '9.15.9');
    assert.equal(disabledRes.env.npm_config_manage_package_manager_versions, 'false');

    const logs = [];
    const failedRes = await resolveFrontendToolchain({
      repoDir,
      installCommand: 'pnpm install',
      preinstalledRoot: path.join(tmpDir, 'preinstalled'),
      cacheRoot: path.join(tmpDir, 'cache'),
      allowAutoInstall: true,
      log: (level, message) => logs.push({ level, message }),
      probeHostVersionFn: async () => '9.15.9',
      installPackageFn: async () => {
        throw new Error('404 Not Found');
      },
    });
    assert.equal(failedRes.source, 'fallback');
    assert.equal(failedRes.version, '9.15.9');
    assert.equal(logs.some((item) => item.level === 'warn' && item.message.includes('404 Not Found')), true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Windows 平台布局与 PATH 分隔符正确处理', () => {
  const layout = resolvePnpmPrefixLayout('C:\\yuyan\\toolchains\\pnpm\\10.15.0', 'win32');
  assert.equal(layout.binDir, 'C:\\yuyan\\toolchains\\pnpm\\10.15.0');
  assert.equal(layout.binPath, path.join('C:\\yuyan\\toolchains\\pnpm\\10.15.0', 'pnpm.cmd'));

  const env = buildPnpmToolchainEnv(layout.binDir, {
    basePath: 'C:\\Windows\\System32',
    platform: 'win32',
  });
  assert.equal(env.PATH, 'C:\\yuyan\\toolchains\\pnpm\\10.15.0;C:\\Windows\\System32');
  assert.equal(env.npm_config_manage_package_manager_versions, 'false');
});
