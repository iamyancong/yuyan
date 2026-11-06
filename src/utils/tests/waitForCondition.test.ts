import assert from 'node:assert/strict';
import test from 'node:test';
import { ref } from 'vue';
import { waitForCondition } from '../waitForCondition.ts';

test('waitForCondition：条件已成立时立即 resolve(true)，不挂监听', async () => {
  const flag = ref(true);
  const started = Date.now();
  const result = await waitForCondition(() => flag.value, 60_000);
  assert.equal(result, true);
  assert.ok(Date.now() - started < 100);
});

test('waitForCondition：条件稍后翻转时立即 resolve(true)，不等到超时', async () => {
  const loading = ref(true);
  const started = Date.now();
  const pending = waitForCondition(() => !loading.value, 60_000);
  setTimeout(() => {
    loading.value = false;
  }, 30);
  const result = await pending;
  assert.equal(result, true);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_000, `条件成立应立即结束，实际耗时 ${elapsed}ms`);
});

test('waitForCondition：超时仍未成立时 resolve(false) 兜底（防上游挂起无限等待）', async () => {
  const flag = ref(false);
  const started = Date.now();
  const result = await waitForCondition(() => flag.value, 40);
  assert.equal(result, false);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 35 && elapsed < 2_000, `应按超时时间兜底，实际耗时 ${elapsed}ms`);
});

test('waitForCondition：超时后 watcher 已停止（条件再翻转不会重复 resolve）', async () => {
  const flag = ref(false);
  let resolveCount = 0;
  const pending = waitForCondition(() => flag.value, 30).then((met) => {
    resolveCount += 1;
    return met;
  });
  assert.equal(await pending, false);
  flag.value = true;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(resolveCount, 1, 'promise 只能 resolve 一次');
});

test('waitForCondition：Infinity 表示无限等待，不产生定时器告警或立即超时', async () => {
  const flag = ref(false);
  const pending = waitForCondition(() => flag.value, Infinity);
  setTimeout(() => {
    flag.value = true;
  }, 30);
  assert.equal(await pending, true);
});
