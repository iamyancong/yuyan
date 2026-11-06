import assert from 'node:assert/strict';
import test from 'node:test';
import { decideTabRefresh, TAB_SILENT_REFRESH_MIN_INTERVAL_MS } from '../tabRefreshPolicy.ts';

const KEY = 'records:{"projectType":"all","page":1}';
const NOW = 1_700_000_000_000;

test('首次进入（未加载过）：强制刷新', () => {
  assert.equal(decideTabRefresh({ loaded: false, currentKey: KEY, now: NOW }), 'force');
});

test('标记已加载但没有快照 key：仍按首次处理强制刷新', () => {
  assert.equal(decideTabRefresh({ loaded: true, currentKey: KEY, now: NOW, loadedAt: NOW - 1000 }), 'force');
});

test('已加载 + 筛选未变 + 刚加载过：直接用缓存，不请求', () => {
  assert.equal(decideTabRefresh({ loaded: true, snapshotKey: KEY, currentKey: KEY, loadedAt: NOW - 1000, now: NOW }), 'none');
});

test('已加载 + 筛选未变 + 缓存较旧：后台静默刷新一次，不强制 loading', () => {
  assert.equal(
    decideTabRefresh({ loaded: true, snapshotKey: KEY, currentKey: KEY, loadedAt: NOW - TAB_SILENT_REFRESH_MIN_INTERVAL_MS, now: NOW }),
    'silent'
  );
});

test('已加载 + 筛选未变 + 被其他 Tab 写操作标记过期（loadedAt=0）：静默刷新', () => {
  assert.equal(decideTabRefresh({ loaded: true, snapshotKey: KEY, currentKey: KEY, loadedAt: 0, now: NOW }), 'silent');
  assert.equal(decideTabRefresh({ loaded: true, snapshotKey: KEY, currentKey: KEY, now: NOW }), 'silent');
});

test('筛选条件变化：强制刷新', () => {
  const changed = 'records:{"projectType":"frontend","page":1}';
  assert.equal(decideTabRefresh({ loaded: true, snapshotKey: KEY, currentKey: changed, loadedAt: NOW - 1000, now: NOW }), 'force');
});

test('筛选变更后 clearTabCache 把 loaded 置 false：即使 key 碰巧一致也强制刷新', () => {
  assert.equal(decideTabRefresh({ loaded: false, snapshotKey: KEY, currentKey: KEY, loadedAt: NOW - 1000, now: NOW }), 'force');
});

test('用户主动点刷新：总是强制刷新', () => {
  assert.equal(decideTabRefresh({ loaded: true, snapshotKey: KEY, currentKey: KEY, loadedAt: NOW - 1000, now: NOW, manual: true }), 'force');
});

test('时钟回拨（loadedAt 在未来）：不信任缓存新鲜度，改为静默刷新', () => {
  assert.equal(decideTabRefresh({ loaded: true, snapshotKey: KEY, currentKey: KEY, loadedAt: NOW + 60_000, now: NOW }), 'silent');
});

test('可自定义静默刷新最小间隔', () => {
  const input = { loaded: true, snapshotKey: KEY, currentKey: KEY, loadedAt: NOW - 3000, now: NOW };
  assert.equal(decideTabRefresh({ ...input, minIntervalMs: 2000 }), 'silent');
  assert.equal(decideTabRefresh({ ...input, minIntervalMs: 5000 }), 'none');
});
