import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseSemVer,
  compareSemVer,
  calculateNextVersion,
  parseArgs,
  resolveReleasePlan,
} from './bump-version.js';

test('parseSemVer: 正确解析版本号', () => {
  assert.deepEqual(parseSemVer('1.3.0'), [1, 3, 0]);
  assert.deepEqual(parseSemVer('v2.0.5'), [2, 0, 5]);
  assert.deepEqual(parseSemVer('1.10.20-beta.1'), [1, 10, 20]);
  assert.deepEqual(parseSemVer('invalid'), [0, 0, 0]);
});

test('compareSemVer: 正确对比版本大小', () => {
  assert.equal(compareSemVer('1.3.1', '1.3.0'), 1);
  assert.equal(compareSemVer('1.2.9', '1.3.0'), -1);
  assert.equal(compareSemVer('1.3.0', '1.3.0'), 0);
  assert.equal(compareSemVer('2.0.0', '1.9.9'), 1);
});

test('calculateNextVersion: 支持 patch / minor / major 正确进位', () => {
  assert.equal(calculateNextVersion({ baseVersion: '1.3.0', bumpType: 'patch' }), '1.3.1');
  assert.equal(calculateNextVersion({ baseVersion: '1.3.9', bumpType: 'patch' }), '1.3.10');
  assert.equal(calculateNextVersion({ baseVersion: '1.3.0', bumpType: 'minor' }), '1.4.0');
  assert.equal(calculateNextVersion({ baseVersion: '1.3.9', bumpType: 'minor' }), '1.4.0');
  assert.equal(calculateNextVersion({ baseVersion: '1.3.0', bumpType: 'major' }), '2.0.0');
  assert.equal(calculateNextVersion({ baseVersion: '1.9.9', bumpType: 'major' }), '2.0.0');
});

test('parseArgs: 正确解析 CLI 命令行参数', () => {
  const parsed1 = parseArgs(['--bump', 'minor', '--dry-run', '--prerelease', '--notes', 'Feature update']);
  assert.equal(parsed1.bumpType, 'minor');
  assert.equal(parsed1.dryRun, true);
  assert.equal(parsed1.prerelease, true);
  assert.equal(parsed1.customNotes, 'Feature update');

  const parsed2 = parseArgs(['--bump=major', '--dry-run=true', '--notes=Major release']);
  assert.equal(parsed2.bumpType, 'major');
  assert.equal(parsed2.dryRun, true);
  assert.equal(parsed2.customNotes, 'Major release');

  // 测试空格分隔布尔值：--dry-run false 与 --prerelease false
  const parsed3 = parseArgs(['--dry-run', 'false', '--prerelease', 'false']);
  assert.equal(parsed3.dryRun, false);
  assert.equal(parsed3.prerelease, false);

  // 测试空格分隔布尔值：--dry-run true 与 --prerelease true
  const parsed4 = parseArgs(['--dry-run', 'true', '--prerelease', 'true']);
  assert.equal(parsed4.dryRun, true);
  assert.equal(parsed4.prerelease, true);

  // 测试等号语法布尔值：--dry-run=false 与 --prerelease=false
  const parsed5 = parseArgs(['--dry-run=false', '--prerelease=false']);
  assert.equal(parsed5.dryRun, false);
  assert.equal(parsed5.prerelease, false);
});

test('resolveReleasePlan: Tag 触发时直接使用 Tag 版本不进行二次 bump', async () => {
  const plan = await resolveReleasePlan({
    githubRef: 'refs/tags/v1.5.0',
    customNotes: 'Manual tag release',
  });

  assert.equal(plan.version, '1.5.0');
  assert.equal(plan.tag, 'v1.5.0');
  assert.equal(plan.prerelease, false);
  assert.ok(plan.release_notes.includes('Manual tag release'));
});

test('resolveReleasePlan: 工作流触发时比对线上与本地并计算下一版本', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyan-bump-test-'));
  const tempTauriConfig = path.join(tempDir, 'tauri.conf.json');
  fs.writeFileSync(tempTauriConfig, JSON.stringify({ version: '1.3.0' }));

  const mockFetch = async () => ({
    ok: true,
    json: async () => [{ tag_name: 'v1.3.2' }],
  });

  const plan = await resolveReleasePlan({
    tauriConfigPath: tempTauriConfig,
    githubRef: 'refs/heads/feat/github-actions-build',
    bumpType: 'minor',
    dryRun: true,
    repo: 'ycwang-dev/yuyan',
    fetchFn: mockFetch,
  });

  // 线上为 1.3.2，本地为 1.3.0，基准为 1.3.2，执行 minor bump 得到 1.4.0
  assert.equal(plan.version, '1.4.0');
  assert.equal(plan.tag, 'v1.4.0');
  assert.equal(plan.dry_run, true);

  fs.rmSync(tempDir, { recursive: true, force: true });
});
