import assert from 'node:assert/strict';
import test from 'node:test';
import {
  refreshCentralData,
  registerCentralDataRefreshHandler,
} from '../centralDataRefresh.ts';

test('中央刷新会等待当前页面处理器真实完成并支持注销', async () => {
  let completed = false;
  const unregister = registerCentralDataRefreshHandler(async () => {
    await Promise.resolve();
    completed = true;
  });
  try {
    const result = await refreshCentralData();
    assert.equal(completed, true);
    assert.deepEqual(result, { handlerCount: 1 });
  } finally {
    unregister();
  }
  assert.deepEqual(await refreshCentralData(), { handlerCount: 0 });
});

test('刷新期间并发调用复用同一轮页面请求', async () => {
  let executions = 0;
  let finishRefresh: () => void = () => undefined;
  const waitForFinish = new Promise<void>((resolve) => {
    finishRefresh = resolve;
  });
  const unregister = registerCentralDataRefreshHandler(async () => {
    executions += 1;
    await waitForFinish;
  });
  try {
    const first = refreshCentralData();
    const second = refreshCentralData();
    await Promise.resolve();
    assert.equal(executions, 1);
    finishRefresh();
    assert.deepEqual(await Promise.all([first, second]), [{ handlerCount: 1 }, { handlerCount: 1 }]);
    assert.equal(executions, 1);
  } finally {
    unregister();
  }
});

test('页面处理器失败会返回真实错误，下一轮仍可恢复刷新', async () => {
  const unregisterFailure = registerCentralDataRefreshHandler(async () => {
    throw new Error('中央接口不可用');
  });
  await assert.rejects(() => refreshCentralData(), /中央接口不可用/);
  unregisterFailure();

  let recovered = false;
  const unregisterRecovery = registerCentralDataRefreshHandler(async () => {
    recovered = true;
  });
  try {
    assert.deepEqual(await refreshCentralData(), { handlerCount: 1 });
    assert.equal(recovered, true);
  } finally {
    unregisterRecovery();
  }
});
