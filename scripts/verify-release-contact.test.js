import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyReleaseContact } from './verify-release-contact.mjs';

/** 模拟公开构建输入，包含容易被 dotenv 或 shell 改写的字符。 */
const contactEnv = {
  VITE_CONTACT_NAME: '测试联系人',
  VITE_CONTACT_WORK_NO: '00123456',
  VITE_CONTACT_COMPANY: '赢时胜',
  VITE_CONTACT_ROLE: '雨燕研发与技术支持',
  VITE_CONTACT_EMAIL: 'release-contact@example.com',
  VITE_CONTACT_CARD_URL: 'https://example.com/card?id=123&source=$SUPPORT#contact',
};

test('完整配置通过，允许公司和职责沿用通用文案', () => {
  assert.doesNotThrow(() => verifyReleaseContact(contactEnv));
});

test('任一联系人字段缺失或只含空白时阻断', () => {
  for (const key of Object.keys(contactEnv)) {
    for (const value of [undefined, '', '  \t  ']) {
      assert.throws(() => verifyReleaseContact({ ...contactEnv, [key]: value }), new RegExp(key));
    }
  }
});

test('拒绝占位姓名、工号、邮箱以及非法邮箱或名片协议', () => {
  for (const [key, value] of [
    ['VITE_CONTACT_NAME', ' 雨燕技术支持 '],
    ['VITE_CONTACT_WORK_NO', '80000000'],
    ['VITE_CONTACT_EMAIL', 'SUPPORT@YUYAN.DEV'],
    ['VITE_CONTACT_EMAIL', 'invalid-email'],
    ['VITE_CONTACT_CARD_URL', 'javascript:alert(1)'],
    ['VITE_CONTACT_CARD_URL', '/card'],
    ['VITE_CONTACT_ROLE', '技术\n支持'],
  ]) {
    assert.throws(() => verifyReleaseContact({ ...contactEnv, [key]: value }), new RegExp(key));
  }
});

test('CLI 失败返回非零状态，成功和失败日志均不输出联系人值', () => {
  const script = fileURLToPath(new URL('./verify-release-contact.mjs', import.meta.url));
  for (const valid of [true, false]) {
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, ...contactEnv, VITE_CONTACT_WORK_NO: valid ? contactEnv.VITE_CONTACT_WORK_NO : '' },
      encoding: 'utf8',
    });
    assert.equal(result.status, valid ? 0 : 1);
    const output = result.stdout + result.stderr;
    for (const value of Object.values(contactEnv)) {
      assert.ok(!output.includes(value));
    }
    if (!valid) assert.match(output, /VITE_CONTACT_WORK_NO/);
  }
});

test('预检（含 dry-run）及所有平台构建均接入全部联系人 Secrets 和门禁', (t) => {
  const workflowUrl = new URL('../.github/workflows/release-tauri.yml', import.meta.url);
  if (!existsSync(workflowUrl)) {
    t.skip('release-tauri.yml 仅在 GitHub Actions 客户端主线存在，当前分支跳过此测试');
    return;
  }
  const workflow = readFileSync(workflowUrl, 'utf8');
  const preflight = workflow.match(
    /      - name: Validate release contact configuration\n([\s\S]*?)(?=\n      - name:)/
  )?.[1];
  const build = workflow.match(/\n  build:\n([\s\S]*?)(?=\n  release:)/)?.[1];
  const buildEnv = build?.match(/\n    env:\n([\s\S]*?)(?=\n    steps:)/)?.[1];
  assert.ok(preflight && build && buildEnv);
  for (const key of Object.keys(contactEnv)) {
    const mapping = `${key}: \${{ secrets.${key} }}`;
    assert.ok(preflight.includes(mapping), `预检缺少 ${key}`);
    assert.ok(buildEnv.includes(mapping), `构建缺少 ${key}`);
  }
  assert.ok(!preflight.includes('if:'), 'dry-run 也必须检查联系人');
  assert.ok(preflight.includes('node scripts/verify-release-contact.mjs'));
  assert.ok(build.includes('needs: [verify-ci, prep-version]'));
  assert.ok(build.includes('node scripts/verify-release-contact.mjs'));
  assert.ok(build.indexOf('node scripts/verify-release-contact.mjs') < build.indexOf('- name: Build Tauri App'));
});
