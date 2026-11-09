import assert from 'node:assert/strict';
import test from 'node:test';
import { ref } from 'vue';
import { useDeployTabTableLayout } from '../useDeployTabTableLayout.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('激活 Tab 后延迟同步高度并触发 onActivated 回调', async () => {
  const active = ref(false);
  let heightCalls = 0;
  let activatedCalls = 0;

  useDeployTabTableLayout({
    active,
    delayMs: 30,
    recalculateHeight: () => {
      heightCalls += 1;
    },
    onActivated: () => {
      activatedCalls += 1;
    },
  });

  active.value = true;
  // 延迟前不触发
  await sleep(10);
  assert.equal(heightCalls, 0);
  assert.equal(activatedCalls, 0);

  // 到达延迟时间后触发
  await sleep(35);
  assert.equal(heightCalls, 1);
  assert.equal(activatedCalls, 1);
});

test('在延迟到达前切走 Tab 会取消同步，不触发重算', async () => {
  const active = ref(false);
  let heightCalls = 0;
  let activatedCalls = 0;

  useDeployTabTableLayout({
    active,
    delayMs: 40,
    recalculateHeight: () => {
      heightCalls += 1;
    },
    onActivated: () => {
      activatedCalls += 1;
    },
  });

  active.value = true;
  await sleep(15);
  // 中途切走
  active.value = false;
  await sleep(40);

  assert.equal(heightCalls, 0);
  assert.equal(activatedCalls, 0);
});
