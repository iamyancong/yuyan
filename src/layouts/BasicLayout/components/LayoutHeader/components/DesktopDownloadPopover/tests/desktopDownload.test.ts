import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPORTED_DOWNLOAD_PLATFORMS,
  GITHUB_RELEASES_URL,
  DESKTOP_DOWNLOAD_GUIDE_STORAGE_KEY,
  matchDefaultPlatform,
  formatFileSize,
  MAC_QUARANTINE_COMMAND,
  MAC_QUARANTINE_TIP,
} from '../constant.ts';

test('matchDefaultPlatform: 根据操作系统和架构正确匹配默认推荐平台', () => {
  // macOS Apple Silicon
  const macArm = matchDefaultPlatform('darwin', 'aarch64');
  assert.equal(macArm.key, 'darwin-arm64');
  assert.equal(macArm.platform, 'darwin');
  assert.equal(macArm.arch, 'aarch64');
  assert.equal(macArm.ext, '.dmg');
  assert.match(macArm.title, /Apple Silicon/);

  // macOS Intel
  const macIntel = matchDefaultPlatform('darwin', 'x86_64');
  assert.equal(macIntel.key, 'darwin-x64');
  assert.equal(macIntel.platform, 'darwin');
  assert.equal(macIntel.arch, 'x86_64');
  assert.equal(macIntel.ext, '.dmg');
  assert.match(macIntel.title, /Intel/);

  // Windows x64
  const win = matchDefaultPlatform('windows', 'x86_64');
  assert.equal(win.key, 'windows-x64');
  assert.equal(win.platform, 'windows');
  assert.equal(win.arch, 'x86_64');
  assert.equal(win.ext, '.exe');
  assert.match(win.title, /Windows/);

  // 未知平台安全回退
  const fallback = matchDefaultPlatform('unknown', 'x86_64');
  assert.equal(fallback.key, 'darwin-arm64');
});

test('formatFileSize: 正确格式化字节大小', () => {
  assert.equal(formatFileSize(0), '');
  assert.equal(formatFileSize(undefined), '');
  assert.equal(formatFileSize(-100), '');
  assert.equal(formatFileSize(NaN), '');

  // 1 MB = 1048576 bytes
  assert.equal(formatFileSize(1048576), '1.0 MB');
  // ~84.5 MB
  assert.equal(formatFileSize(88604672), '84.5 MB');
});

test('SUPPORTED_DOWNLOAD_PLATFORMS: 平台安装包配置完整且无缺失', () => {
  assert.equal(SUPPORTED_DOWNLOAD_PLATFORMS.length, 3);

  for (const item of SUPPORTED_DOWNLOAD_PLATFORMS) {
    assert.ok(item.key);
    assert.ok(item.title);
    assert.ok(item.ctaLabel);
    assert.ok(item.ctaTitle);
    assert.ok(item.ctaRecommendDesc);
    assert.ok(item.desc);
    if (item.platform === 'darwin') {
      assert.equal(item.ext, '.dmg');
      assert.equal(item.icon, 'apple');
    } else {
      assert.equal(item.ext, '.exe');
      assert.equal(item.icon, 'windows');
    }
  }
});

test('constant: 官方发布兜底链接与持久化键名规范', () => {
  assert.match(GITHUB_RELEASES_URL, /^https:\/\/github\.com\/iamyancong\/yuyan\/releases/);
  assert.equal(DESKTOP_DOWNLOAD_GUIDE_STORAGE_KEY, 'yuyan_web_desktop_download_guide_dismissed');
});

test('constant: macOS 隔离解除命令与提示规范', () => {
  assert.equal(
    MAC_QUARANTINE_COMMAND,
    'sudo xattr -rd com.apple.quarantine /Applications/雨燕.app/'
  );
  assert.match(MAC_QUARANTINE_COMMAND, /com\.apple\.quarantine/);
  assert.match(MAC_QUARANTINE_COMMAND, /\/Applications\/雨燕\.app\//);
  assert.ok(MAC_QUARANTINE_TIP.length > 0);
});
