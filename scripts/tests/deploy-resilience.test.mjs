import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import path from 'node:path';

/** 使用实际 Vue composable，仅隔离网络与桌面通知，避免测试触发部署副作用。 */
const apiNames = [
  'deployTargetWithProgress',
  'getTargetDeployProgress',
  'rollbackRecordWithProgress',
  'runBackendServiceActionWithProgress',
  'stopTargetDeploy',
  'subscribeTargetDeployProgress',
  'undoRollbackRecordWithProgress',
];
const result = await build({
  stdin: {
    contents: `export { ref, effectScope, nextTick, watch } from 'vue';
    export { useNginxDeployProgress } from './src/views/NginxDeploy/hooks/useNginxDeployProgress.ts';
    export { useNginxDeployLifecycle } from './src/views/NginxDeploy/hooks/useNginxDeployLifecycle.ts';
    export { useCentralRefreshRecovery } from './src/views/NginxDeploy/hooks/useCentralRefreshRecovery.ts';
    export { DeployResultUnconfirmed, reconcileDeployTask } from './src/api/deployTaskRecovery.ts';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [
    {
      name: 'isolated-boundaries',
      setup(build) {
        build.onResolve({ filter: /^vue$/ }, (args) =>
          args.importer.endsWith('/useNginxDeployLifecycle.ts') ? { path: 'lifecycle', namespace: 'mock' } : undefined
        );
        build.onResolve({ filter: /^@\/api\/deploy$/ }, () => ({ path: 'api', namespace: 'mock' }));
        build.onResolve({ filter: /useNginxDeployContext$/ }, () => ({ path: 'context', namespace: 'mock' }));
        build.onResolve({ filter: /ant-design-vue\/es\/message$/ }, () => ({ path: 'message', namespace: 'mock' }));
        build.onResolve({ filter: /deployNotification$/ }, () => ({ path: 'notify', namespace: 'mock' }));
        build.onResolve({ filter: /^\.\.\/(utils|constant)$/ }, ({ path }) => ({ path, namespace: 'mock' }));
        build.onResolve({ filter: /^@\// }, (args) => ({ path: path.resolve('src', args.path.slice(2) + '.ts') }));
        build.onLoad({ filter: /.*/, namespace: 'mock' }, ({ path }) => ({
          resolveDir: process.cwd(),
          contents: {
            lifecycle: `export * from 'vue';
        export const onActivated = callback => globalThis.__lifecycleTest.activate = callback;
        export const onDeactivated = callback => globalThis.__lifecycleTest.deactivate = callback;`,
            api: apiNames.map((name) => `export const ${name} = (...args) => globalThis.__deployTest.api.${name}(...args);`).join('\n'),
            context: 'export const useNginxDeployContext = () => null;',
            message: 'export default { success() {}, warning() {}, error() {}, info() {} };',
            notify: 'export const notifyDeployResult = (result) => globalThis.__deployTest.notifications.push(result);',
            '../utils': `export const getErrorMessage = error => error.message || String(error);
        export const isAbortError = error => error?.name === 'AbortError';
        export const isDeployConflictError = error => error?.status === 409;
        export const isNotFoundError = error => error?.status === 404;`,
            '../constant': `export const DEPLOY_FAILURE_BRIEF = '发布失败';
        export const getDeployProgressActionLabel = () => '发布';
        export const getDeployProgressFailureTitle = () => '执行失败';
        export const getDeployProgressStageLabel = () => '构建';`,
          }[path],
        }));
      },
    },
  ],
});
const {
  ref,
  effectScope,
  watch,
  useNginxDeployLifecycle,
  useNginxDeployProgress,
  useCentralRefreshRecovery,
  DeployResultUnconfirmed,
  reconcileDeployTask,
} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

/** 等待真实响应式条件，避免依赖微任务数量。 */
function waitUntil(condition) {
  if (condition()) return Promise.resolve();
  return new Promise((resolve) => {
    watch(condition, () => resolve(), { once: true, flush: 'sync' });
  });
}

/** 只替换 KeepAlive 生命周期注册，其余页面刷新逻辑保持真实实现。 */
function createLifecycle(read) {
  globalThis.__lifecycleTest = {};
  const scope = effectScope();
  const lifecycle = scope.run(() =>
    useNginxDeployLifecycle({
      isLoggedIn: ref(true),
      ensureLoggedIn: () => true,
      refreshTargetList: read,
      refreshServerList: read,
    })
  );
  return { lifecycle, scope, hooks: globalThis.__lifecycleTest };
}

test('恢复中取消会同时清除提示和禁用状态，取消后的 promise 不会恢复故障状态', { timeout: 2000 }, async () => {
  const recovery = useCentralRefreshRecovery();
  const pending = recovery.run('targets', async () => {
    throw Object.assign(new Error('offline'), { status: 503 });
  });
  await waitUntil(() => recovery.retrying.value);
  assert.equal(recovery.unavailable.value, true);
  recovery.cancel();
  assert.equal(recovery.status.value, 'idle');
  assert.equal(recovery.error.value, null);
  assert.equal(recovery.unavailable.value, false);
  await pending;
  assert.equal(recovery.unavailable.value, false);
  await recovery.run('servers', async () => {});
  assert.equal(recovery.unavailable.value, false);
});

test('缓存 Tab 恢复中切换到已加载 Tab，立即解除禁用并重新查询', { timeout: 2000 }, async () => {
  let offline = false;
  let reads = 0;
  const { lifecycle, scope } = createLifecycle(async () => {
    reads += 1;
    if (offline) throw Object.assign(new Error('offline'), { status: 503 });
  });
  try {
    lifecycle.activeTabKey.value = 'servers';
    await lifecycle.refreshActiveTab();
    lifecycle.activeTabKey.value = 'targets';
    await lifecycle.refreshActiveTab();
    offline = true;
    const pending = lifecycle.refreshActiveTab();
    await waitUntil(() => lifecycle.centralUnavailable.value);
    assert.equal(lifecycle.refreshWarning.value, true);
    offline = false;
    const previousReads = reads;
    lifecycle.handleTabChange('servers');
    assert.equal(lifecycle.tabLoadedFlags.value.servers, true);
    assert.equal(lifecycle.centralUnavailable.value, false);
    assert.equal(lifecycle.refreshWarning.value, false);
    assert.equal(lifecycle.refreshError.value, '');
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(reads, previousReads + 1);
    assert.equal(lifecycle.centralUnavailable.value, false);
  } finally {
    scope.stop();
  }
});

test('恢复中停用清除禁用状态，再激活仍会重新探测中央服务', { timeout: 2000 }, async () => {
  let offline = false;
  let reads = 0;
  const { lifecycle, scope, hooks } = createLifecycle(async () => {
    reads += 1;
    if (offline) throw Object.assign(new Error('offline'), { status: 503 });
  });
  try {
    await lifecycle.refreshActiveTab();
    offline = true;
    const pending = lifecycle.refreshActiveTab();
    await waitUntil(() => lifecycle.centralUnavailable.value);
    hooks.deactivate();
    assert.equal(lifecycle.centralUnavailable.value, false);
    await pending;
    offline = false;
    const previousReads = reads;
    hooks.activate();
    await lifecycle.refreshActiveTab();
    assert.equal(reads, previousReads + 2);
    assert.equal(lifecycle.centralUnavailable.value, false);
  } finally {
    scope.stop();
  }
});

/** 创建独立任务工作台。 */
function createProgress(api, refresh = async () => {}) {
  globalThis.__deployTest = { api, notifications: [] };
  const scope = effectScope();
  const progress = scope.run(() =>
    useNginxDeployProgress({
      ensureLoggedIn: () => true,
      refreshActiveTab: refresh,
      authState: ref({ token: '', role: 'operator' }),
      userName: ref('tester'),
      activeRecord: ref(null),
    })
  );
  progress.activePublishTarget.value = { id: 1, projectType: 'frontend', projectName: 'demo', envName: 'test' };
  return { progress, scope };
}

test('发布成功后列表刷新失败，保留成功结果且只发一次成功通知', async () => {
  let refreshes = 0;
  const { progress, scope } = createProgress(
    {
      deployTargetWithProgress: async (_id, _type, _payload, options) => {
        const result = { id: 9, status: 'success' };
        options.onEvent({ type: 'result', data: result, timestamp: 'done' });
        return result;
      },
    },
    async () => {
      refreshes += 1;
      throw new Error('Network Error');
    }
  );
  await progress.startPublishFromConfirm();
  assert.equal(progress.progressState.title, '发布完成');
  assert.equal(progress.progressState.running, false);
  assert.equal(progress.publishConfirmOpen.value, true);
  assert.equal(
    progress.progressState.logs.some((event) => event.type === 'error'),
    false
  );
  assert.deepEqual(
    globalThis.__deployTest.notifications.map((item) => item.status),
    ['success']
  );
  assert.equal(refreshes, 1);
  scope.stop();
});

test('回滚成功后刷新失败不改成回滚失败', async () => {
  const { progress, scope } = createProgress(
    {
      rollbackRecordWithProgress: async (_id, _type, _payload, options) => {
        options.onEvent({ type: 'result', data: { status: 'success' }, timestamp: 'done' });
      },
    },
    async () => {
      throw new Error('Network Error');
    }
  );
  await progress.runRollback({ id: 1, projectType: 'frontend' });
  assert.equal(progress.progressState.title, '发布完成');
  assert.equal(
    progress.progressState.logs.some((event) => event.type === 'error'),
    false
  );
  scope.stop();
});

test('未确认任务保留抽屉，不报执行失败，不允许再次发布，可只读核实', async () => {
  let starts = 0;
  const { progress, scope } = createProgress({
    deployTargetWithProgress: async () => {
      starts += 1;
      throw new DeployResultUnconfirmed(async () => ({ id: 9, status: 'success' }));
    },
  });
  await progress.startPublishFromConfirm();
  assert.equal(progress.resultUnconfirmed.value, true);
  assert.equal(progress.publishConfirmOpen.value, true);
  assert.equal(globalThis.__deployTest.notifications.length, 0);
  await progress.republishFromConfirm();
  assert.equal(starts, 1);
  await progress.verifyResult();
  assert.equal(progress.resultUnconfirmed.value, false);
  assert.equal(progress.progressState.title, '发布完成');
  assert.equal(starts, 1);
  scope.stop();
});

test('同一列表查询只发一次，新查询取消旧查询，旧失败不能覆盖恢复态', async () => {
  const recovery = useCentralRefreshRecovery();
  let firstSignal;
  let resolveFirst;
  let starts = 0;
  const first = recovery.run('team-a:targets', async (signal) => {
    firstSignal = signal;
    starts += 1;
    await new Promise((resolve) => {
      resolveFirst = resolve;
    });
  });
  const same = recovery.run('team-a:targets', async () => {
    starts += 1;
  });
  assert.equal(first, same);
  await recovery.run('team-b:targets', async () => {
    starts += 1;
  });
  assert.equal(firstSignal.aborted, true);
  resolveFirst();
  await first;
  assert.equal(starts, 2);
  assert.equal(recovery.error.value, null);
  assert.equal(recovery.unavailable.value, false);
});

test('服务端确认中断时对账展示失败，不返回伪造成功', async () => {
  await assert.rejects(
    reconcileDeployTask(async () => ({ running: false, result: null, error: 'service_restarted' })),
    /service_restarted/
  );
  assert.deepEqual(await reconcileDeployTask(async () => ({ running: false, result: { id: 8, status: 'success' }, error: null })), {
    id: 8,
    status: 'success',
  });
});

test('核实期间清理身份后，旧任务结果不得回写新页面', async () => {
  let complete;
  const { progress, scope } = createProgress({
    deployTargetWithProgress: async () => {
      throw new DeployResultUnconfirmed(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          })
      );
    },
  });
  await progress.startPublishFromConfirm();
  const pending = progress.verifyResult();
  progress.clearProgressData();
  complete({ status: 'success', id: 9 });
  await pending;
  assert.equal(progress.progressState.title, '');
  assert.equal(progress.publishConfirmOpen.value, false);
  assert.equal(progress.activePublishTarget.value, null);
  scope.stop();
});
