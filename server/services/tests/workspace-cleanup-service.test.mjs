import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  WORKSPACE_USED_MARKER,
  cleanupIdleWorkspaces,
  parseWorkspaceCleanupIntervalHours,
  parseWorkspaceIdleDays,
  touchWorkspaceUsed,
  withTargetWorkspaceLease,
} from '../workspace-cleanup-service.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 创建一个分支工作区，并把其中所有路径的 mtime 设为指定天数之前。
 * @param {string} root 工作区根目录
 * @param {string} targetId 目标 ID
 * @param {string} branchHash 分支哈希
 * @param {number} ageDays 闲置天数
 * @returns {Promise<string>} 分支工作区目录
 */
async function createWorkspace(root, targetId, branchHash, ageDays) {
  const dir = path.join(root, targetId, branchHash);
  await fs.mkdir(path.join(dir, 'repo', '.git'), { recursive: true });
  await fs.mkdir(path.join(dir, 'repo', 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(dir, 'repo', '.git', 'HEAD'), 'ref: refs/heads/dev\n');
  await fs.writeFile(path.join(dir, 'repo', 'node_modules', 'pkg', 'index.js'), 'x'.repeat(4096));
  await touchWorkspaceUsed(dir);
  const time = new Date(Date.now() - ageDays * DAY_MS);
  const stack = [dir];
  const all = [];
  while (stack.length) {
    const current = stack.pop();
    all.push(current);
    const stat = await fs.lstat(current);
    if (stat.isDirectory()) for (const name of await fs.readdir(current)) stack.push(path.join(current, name));
  }
  for (const item of all.reverse()) await fs.utimes(item, time, time);
  return dir;
}

async function makeRoot() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-ws-cleanup-'));
  const root = path.join(base, 'workspaces');
  await fs.mkdir(root, { recursive: true });
  return { base, root };
}

const exists = (p) => fs.lstat(p).then(() => true, () => false);

test('解析闲置天数与间隔：空值/非法值回退默认，0 表示关闭', () => {
  assert.equal(parseWorkspaceIdleDays(''), 7);
  assert.equal(parseWorkspaceIdleDays('abc'), 7);
  assert.equal(parseWorkspaceIdleDays('-1'), 7);
  assert.equal(parseWorkspaceIdleDays('0'), 0);
  assert.equal(parseWorkspaceIdleDays('3'), 3);
  assert.equal(parseWorkspaceCleanupIntervalHours(''), 6);
  assert.equal(parseWorkspaceCleanupIntervalHours('0'), 6);
  assert.equal(parseWorkspaceCleanupIntervalHours('12'), 12);
});

test('只清理超过闲置天数的工作区，并统计释放字节数', async () => {
  const { base, root } = await makeRoot();
  const stale = await createWorkspace(root, '11', 'aaaa', 10);
  const fresh = await createWorkspace(root, '11', 'bbbb', 1);
  const staleOnly = await createWorkspace(root, '12', 'cccc', 30);
  const logs = [];
  const result = await cleanupIdleWorkspaces({ root, idleDays: 7, log: (m) => logs.push(m) });
  assert.equal(await exists(stale), false);
  assert.equal(await exists(fresh), true);
  assert.equal(await exists(staleOnly), false);
  assert.equal(await exists(path.join(root, '12')), false, '目标下已无工作区时移除空目录');
  assert.equal(result.removed.length, 2);
  assert.ok(result.freedBytes >= 8192);
  assert.ok(logs.some((m) => m.includes('11/aaaa') && m.includes('释放')));
  assert.ok(logs.some((m) => m.includes('本轮共清理 2 个工作区')));
  const leftovers = (await fs.readdir(root)).filter((n) => n.startsWith('.trash-'));
  assert.deepEqual(leftovers, []);
  await fs.rm(base, { recursive: true, force: true });
});

test('标记文件较新时即使其它文件很旧也不清理', async () => {
  const { base, root } = await makeRoot();
  const dir = await createWorkspace(root, '21', 'aaaa', 20);
  const now = new Date();
  await fs.utimes(path.join(dir, WORKSPACE_USED_MARKER), now, now);
  const result = await cleanupIdleWorkspaces({ root, idleDays: 7, log: () => {} });
  assert.equal(result.removed.length, 0);
  assert.equal(await exists(dir), true);
  await fs.rm(base, { recursive: true, force: true });
});

test('运行/排队中的目标与持有租约的目标不会被清理', async () => {
  const { base, root } = await makeRoot();
  const busy = await createWorkspace(root, '31', 'aaaa', 30);
  const leased = await createWorkspace(root, '32', 'aaaa', 30);
  let result;
  await withTargetWorkspaceLease(32, async () => {
    result = await cleanupIdleWorkspaces({ root, idleDays: 7, isTargetBusy: (id) => id === '31', log: () => {} });
  });
  assert.equal(await exists(busy), true);
  assert.equal(await exists(leased), true);
  assert.deepEqual(result.skipped.filter((s) => s.reason === 'in-use').map((s) => path.basename(path.dirname(s.path))).sort(), ['31', '32']);
  // 租约释放后可以正常清理
  const after = await cleanupIdleWorkspaces({ root, idleDays: 7, isTargetBusy: (id) => id === '31', log: () => {} });
  assert.equal(await exists(leased), false);
  assert.equal(await exists(busy), true);
  assert.equal(after.removed.length, 1);
  await fs.rm(base, { recursive: true, force: true });
});

test('符号链接不跟随、不删除链接指向的目录', async () => {
  const { base, root } = await makeRoot();
  const outside = path.join(base, 'outside');
  await createWorkspace(outside, 'x', 'victim', 30);
  const victim = path.join(outside, 'x', 'victim');
  // 目标级与分支级符号链接都指向根目录外
  await fs.symlink(path.join(outside, 'x'), path.join(root, '41'));
  await fs.mkdir(path.join(root, '42'), { recursive: true });
  await fs.symlink(victim, path.join(root, '42', 'linked'));
  const result = await cleanupIdleWorkspaces({ root, idleDays: 7, log: () => {} });
  assert.equal(result.removed.length, 0);
  assert.equal(await exists(victim), true);
  assert.equal(await exists(path.join(victim, 'repo', 'node_modules', 'pkg', 'index.js')), true);
  assert.ok(result.skipped.some((s) => s.reason === 'symlink'));
  await fs.rm(base, { recursive: true, force: true });
});

test('工作区内部的符号链接只删链接本身，不删外部文件', async () => {
  const { base, root } = await makeRoot();
  const outsideFile = path.join(base, 'keep.txt');
  await fs.writeFile(outsideFile, 'keep');
  const dir = await createWorkspace(root, '51', 'aaaa', 30);
  await fs.symlink(outsideFile, path.join(dir, 'repo', 'link.txt'));
  const old = new Date(Date.now() - 30 * DAY_MS);
  await fs.lutimes(path.join(dir, 'repo', 'link.txt'), old, old);
  await fs.utimes(path.join(dir, 'repo'), old, old);
  await cleanupIdleWorkspaces({ root, idleDays: 7, log: () => {} });
  assert.equal(await exists(dir), false);
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'keep');
  await fs.rm(base, { recursive: true, force: true });
});

test('idleDays=0 关闭清理；根目录不存在时安全返回；遗留回收站目录会被清掉', async () => {
  const { base, root } = await makeRoot();
  const dir = await createWorkspace(root, '61', 'aaaa', 30);
  const disabled = await cleanupIdleWorkspaces({ root, idleDays: 0, log: () => {} });
  assert.equal(disabled.disabled, true);
  assert.equal(await exists(dir), true);
  const missing = await cleanupIdleWorkspaces({ root: path.join(base, 'nope'), idleDays: 7, log: () => {} });
  assert.equal(missing.removed.length, 0);
  await fs.mkdir(path.join(root, '.trash-1-abcd', 'x'), { recursive: true });
  await cleanupIdleWorkspaces({ root, idleDays: 7, log: () => {} });
  assert.equal(await exists(path.join(root, '.trash-1-abcd')), false);
  await fs.rm(base, { recursive: true, force: true });
});

test('租约持有期间工作区不会在中途被删除（清理与新任务并发）', async () => {
  const { base, root } = await makeRoot();
  for (let round = 0; round < 20; round += 1) {
    const dir = await createWorkspace(root, '71', `r${round}`, 30);
    const cleanup = cleanupIdleWorkspaces({ root, idleDays: 7, log: () => {} });
    for (let i = 0; i < round % 5; i += 1) await new Promise((r) => setImmediate(r));
    let before;
    let after;
    await withTargetWorkspaceLease(71, async () => {
      before = await exists(dir);
      await new Promise((r) => setTimeout(r, 5));
      after = await exists(dir);
    });
    await cleanup;
    assert.equal(before, after, `第 ${round} 轮：租约期间工作区状态发生变化`);
  }
  await fs.rm(base, { recursive: true, force: true });
});
