import assert from 'node:assert/strict';
import test from 'node:test';
import { syncAppIcon } from '../appIconSync.ts';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('网页端（非 Tauri）：不加载也不调用 invoke', async () => {
  let loaded = 0;
  const started = syncAppIcon(true, {
    isTauri: () => false,
    loadInvoke: async () => {
      loaded += 1;
      return async () => undefined;
    },
  });
  await flush();
  assert.equal(started, false);
  assert.equal(loaded, 0);
});

test('默认依赖在纯 Node（无 window）下视为非 Tauri，直接跳过', () => {
  assert.equal(syncAppIcon(false), false);
});

test('桌面端：调用 change_app_icon 并透传 isDark', async () => {
  const calls: Array<[string, unknown]> = [];
  const started = syncAppIcon(true, {
    isTauri: () => true,
    loadInvoke: async () => async (cmd, args) => {
      calls.push([cmd, args]);
    },
  });
  await flush();
  assert.equal(started, true);
  assert.deepEqual(calls, [['change_app_icon', { isDark: true }]]);
});

test('桌面端 invoke 失败只记录错误，不抛出', async () => {
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    syncAppIcon(false, {
      isTauri: () => true,
      loadInvoke: async () => async () => {
        throw new Error('boom');
      },
    });
    await flush();
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 1);
});
