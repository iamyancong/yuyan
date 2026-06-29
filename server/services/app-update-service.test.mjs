import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareAppVersions,
  isNewerAppVersion,
  selectLatestCompatibleRelease,
} from './app-update-service.mjs';

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

test('选择版本最高且包含 macOS 安装包的非草稿 Release', () => {
  const releases = [
    createRelease('v1.0.0-9a0e1df', ['雨燕_1.0.0_aarch64.dmg']),
    createRelease('v1.0.3', ['雨燕_1.0.3_x64-setup.exe']),
    createRelease('v1.0.2', ['雨燕_1.0.2_aarch64.dmg', '雨燕_1.0.2_x64-setup.exe']),
    createRelease('v9.0.0', ['雨燕_9.0.0_aarch64.dmg'], { draft: true }),
  ];

  const result = selectLatestCompatibleRelease(releases, 'darwin');
  assert.equal(result?.release.tag_name, 'v1.0.2');
  assert.equal(result?.asset.name, '雨燕_1.0.2_aarch64.dmg');
});

test('Windows 客户端只选择 EXE 安装包', () => {
  const releases = [
    createRelease('v1.0.3', ['雨燕_1.0.3_aarch64.dmg']),
    createRelease('v1.0.2', ['雨燕_1.0.2_x64-setup.exe']),
  ];

  const result = selectLatestCompatibleRelease(releases, 'windows');
  assert.equal(result?.release.tag_name, 'v1.0.2');
  assert.equal(result?.asset.name, '雨燕_1.0.2_x64-setup.exe');
});
