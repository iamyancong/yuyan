import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeApplicationKind,
  resolveApplicationKind,
  shouldShowListenPort,
} from '../applicationKindPolicy.ts';

test('normalizeApplicationKind: 仅接受 main 和 micro，其余非法或空值归一化为 空字符串', () => {
  assert.equal(normalizeApplicationKind('main'), 'main');
  assert.equal(normalizeApplicationKind('micro'), 'micro');
  assert.equal(normalizeApplicationKind(''), '');
  assert.equal(normalizeApplicationKind(undefined), '');
  assert.equal(normalizeApplicationKind(null), '');
  assert.equal(normalizeApplicationKind('other'), '');
  assert.equal(normalizeApplicationKind(123), '');
});

test('resolveApplicationKind: detected 优先，未识别或失败时回落到 saved', () => {
  // detected 明确识别出 main 或 micro 时优先采用
  assert.equal(resolveApplicationKind({ detected: 'micro', saved: 'main' }), 'micro');
  assert.equal(resolveApplicationKind({ detected: 'main', saved: 'micro' }), 'main');
  assert.equal(resolveApplicationKind({ detected: 'micro', saved: '' }), 'micro');

  // detected 为空或非法时，回退到 saved
  assert.equal(resolveApplicationKind({ detected: '', saved: 'micro' }), 'micro');
  assert.equal(resolveApplicationKind({ detected: undefined, saved: 'main' }), 'main');
  assert.equal(resolveApplicationKind({ detected: 'invalid', saved: 'micro' }), 'micro');

  // 两者都未识别时为 ''
  assert.equal(resolveApplicationKind({ detected: '', saved: '' }), '');
  assert.equal(resolveApplicationKind({ detected: undefined, saved: undefined }), '');
});

test('shouldShowListenPort: main 显示、micro 隐藏、unknown 显示、micro+托管站点显示、backend 隐藏', () => {
  // 1. 后端目标始终隐藏端口
  assert.equal(shouldShowListenPort({ projectType: 'backend', applicationKind: 'main' }), false);
  assert.equal(shouldShowListenPort({ projectType: 'backend', applicationKind: 'micro' }), false);
  assert.equal(shouldShowListenPort({ projectType: 'backend', applicationKind: '' }), false);

  // 2. 微应用且未开启平台托管站点：隐藏
  assert.equal(shouldShowListenPort({ projectType: 'frontend', applicationKind: 'micro', nginxSiteManaged: false }), false);
  assert.equal(shouldShowListenPort({ projectType: 'frontend', applicationKind: 'micro' }), false);

  // 3. 微应用且开启平台托管站点：显示（端口是平台生成站点配置的依据）
  assert.equal(shouldShowListenPort({ projectType: 'frontend', applicationKind: 'micro', nginxSiteManaged: true }), true);

  // 4. 主应用：始终显示
  assert.equal(shouldShowListenPort({ projectType: 'frontend', applicationKind: 'main', nginxSiteManaged: false }), true);
  assert.equal(shouldShowListenPort({ projectType: 'frontend', applicationKind: 'main', nginxSiteManaged: true }), true);

  // 5. 未识别（'' 或未知）：照常显示，保守不隐藏
  assert.equal(shouldShowListenPort({ projectType: 'frontend', applicationKind: '', nginxSiteManaged: false }), true);
  assert.equal(shouldShowListenPort({ projectType: 'frontend', applicationKind: undefined, nginxSiteManaged: false }), true);
});
