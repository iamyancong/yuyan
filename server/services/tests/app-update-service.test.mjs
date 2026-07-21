import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareAppVersions,
  isNewerAppVersion,
  resolveCompatibleUpdaterAsset,
  selectLatestCompatibleRelease,
} from '../app-update-service.mjs';

/** 创建测试用 GitHub Release。 */
const createRelease = (tagName, assets, options = {}) => ({
  tag_name: tagName,
  draft: false,
  prerelease: true,
  assets: assets.map((name, index) => ({
    id: index + 1,
    name,
    size: 1024,
  })),
  ...options,
});

test('语义版本比较遵循正式版高于同版本预发布版', () => {
  assert.equal(compareAppVersions('1.0.2', '1.0.1'), 1);
  assert.equal(compareAppVersions('1.0.2', '1.0.2-beta.1'), 1);
  assert.equal(compareAppVersions('1.0.2-beta.2', '1.0.2-beta.1'), 1);
});

test('1.0.1 客户端可检测到 1.0.2 更新', () => {
  assert.equal(isNewerAppVersion('1.0.1', 'v1.0.2'), true);
  assert.equal(isNewerAppVersion('1.0.2', 'v1.0.2'), false);
});

test('Apple Silicon 客户端选择版本最高的 ARM64 DMG', () => {
  const releases = [
    createRelease('v1.0.0-9a0e1df', ['yuyan_1.0.0_aarch64.dmg']),
    createRelease('v1.0.3', ['yuyan_1.0.3_x64.dmg', 'yuyan_1.0.3_x64-setup.exe']),
    createRelease('v1.0.2', ['yuyan_1.0.2_aarch64.dmg', 'yuyan_1.0.2_x64.dmg']),
    createRelease('v9.0.0', ['yuyan_9.0.0_aarch64.dmg'], { draft: true }),
  ];

  const result = selectLatestCompatibleRelease(releases, 'darwin', 'aarch64');
  assert.equal(result?.release.tag_name, 'v1.0.2');
  assert.equal(result?.asset.name, 'yuyan_1.0.2_aarch64.dmg');
});

test('Intel Mac 客户端只选择 x86_64 DMG', () => {
  const releases = [
    createRelease('v1.0.3', ['yuyan_1.0.3_aarch64.dmg']),
    createRelease('v1.0.2', ['yuyan_1.0.2_aarch64.dmg', 'yuyan_1.0.2_x64.dmg']),
  ];

  const result = selectLatestCompatibleRelease(releases, 'darwin', 'x86_64');
  assert.equal(result?.release.tag_name, 'v1.0.2');
  assert.equal(result?.asset.name, 'yuyan_1.0.2_x64.dmg');
});

test('Windows 客户端只选择 EXE 安装包', () => {
  const releases = [
    createRelease('v1.0.3', ['yuyan_1.0.3_aarch64.dmg']),
    createRelease('v1.0.2', ['yuyan_1.0.2_x64-setup.exe']),
  ];

  const result = selectLatestCompatibleRelease(releases, 'windows');
  assert.equal(result?.release.tag_name, 'v1.0.2');
  assert.equal(result?.asset.name, 'yuyan_1.0.2_x64-setup.exe');
});

test('latest.json 只解析同版本、同平台且存在于 Release 的签名 Updater 资源', () => {
  const release = createRelease('v1.2.3', [
    'yuyan_1.2.3_aarch64.dmg',
    'yuyan_1.2.3_darwin-aarch64.app.tar.gz',
  ]);
  const manifest = {
    version: '1.2.3',
    platforms: {
      'darwin-aarch64': {
        url: 'https://github.com/ycwang-dev/yuyan/releases/download/v1.2.3/yuyan_1.2.3_darwin-aarch64.app.tar.gz',
        signature: 'signed-updater',
      },
    },
  };

  const result = resolveCompatibleUpdaterAsset(release, manifest, 'darwin', 'aarch64');
  assert.equal(result?.asset.name, 'yuyan_1.2.3_darwin-aarch64.app.tar.gz');
  assert.equal(result?.signature, 'signed-updater');
  assert.equal(
    resolveCompatibleUpdaterAsset(release, { ...manifest, version: '1.2.4' }, 'darwin', 'aarch64'),
    null
  );
  assert.equal(
    resolveCompatibleUpdaterAsset(release, {
      ...manifest,
      platforms: {
        'darwin-aarch64': {
          url: 'https://example.com/yuyan.app.tar.gz',
          signature: 'signed-updater',
        },
      },
    }, 'darwin', 'aarch64'),
    null
  );
});
