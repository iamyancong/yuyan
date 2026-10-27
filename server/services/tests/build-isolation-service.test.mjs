import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyLowProcessPriority,
  buildIsolatedCommandEnv,
  BuildMemoryBudgetExceededError,
  BuildOomCannotExpandError,
  createBuildSlotLimiter,
  createProcessTreeRssSampler,
  DEFAULT_BUILD_INITIAL_RESERVE_MB,
  DEFAULT_BUILD_MAX_OLD_SPACE_MB,
  DEFAULT_MAX_CONCURRENT_BUILDS,
  detectSystemMemoryMb,
  executeBuildWithOomRetry,
  extractInlineCommandEnv,
  FALLBACK_RETRY_MAX_OLD_SPACE_MB,
  formatBuildWaitStage,
  parsePsOutputToProcessTreeRssMb,
  resolveBuildHeapLimitMb,
  resolveBuildMemoryRequirementMb,
  resolveOomRetryMaxOldSpaceMb,
  sampleProcessTreeRssMb,
} from '../build-isolation-service.mjs';

/**
 * 创建测试用可控 Promise。
 * @returns {{promise: Promise<any>, resolve: (val?: any) => void}}
 */
function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('默认本地构建并发槽位位于 3~5 区间，支持 FIFO 等待与取消', async () => {
  assert.ok(
    DEFAULT_MAX_CONCURRENT_BUILDS >= 3 && DEFAULT_MAX_CONCURRENT_BUILDS <= 5,
    `期望默认构建槽位在 3~5 之间，实际为 ${DEFAULT_MAX_CONCURRENT_BUILDS}`
  );

  const limiter = createBuildSlotLimiter({ maxConcurrent: 2 });
  const d1 = createDeferred();
  const d2 = createDeferred();
  const d3 = createDeferred();

  const waitRecords = [];
  const executionOrder = [];

  const p1 = limiter.withBuildSlot(async () => {
    executionOrder.push('start-1');
    await d1.promise;
    executionOrder.push('end-1');
    return 'res-1';
  });

  const p2 = limiter.withBuildSlot(async () => {
    executionOrder.push('start-2');
    await d2.promise;
    executionOrder.push('end-2');
    return 'res-2';
  });

  const abortController3 = new AbortController();
  const p3 = limiter.withBuildSlot(
    async () => {
      executionOrder.push('start-3');
      await d3.promise;
      return 'res-3';
    },
    {
      signal: abortController3.signal,
      onWait: (info) => waitRecords.push({ id: 3, ...info }),
    }
  );

  const p4 = limiter.withBuildSlot(
    async () => {
      executionOrder.push('start-4');
      return 'res-4';
    },
    {
      onWait: (info) => waitRecords.push({ id: 4, ...info }),
    }
  );

  const statsWhileBusy = limiter.getStats();
  assert.equal(statsWhileBusy.activeBuilds, 2);
  assert.equal(statsWhileBusy.waitingBuilds, 2);
  assert.equal(statsWhileBusy.maxConcurrentBuilds, 2);
  assert.equal(waitRecords.length, 2);
  assert.deepEqual(
    waitRecords.map((item) => ({
      id: item.id,
      waitingPosition: item.waitingPosition,
      activeBuilds: item.activeBuilds,
      maxConcurrentBuilds: item.maxConcurrentBuilds,
      waitingReason: item.waitingReason,
    })),
    [
      { id: 3, waitingPosition: 1, activeBuilds: 2, maxConcurrentBuilds: 2, waitingReason: 'slot' },
      { id: 4, waitingPosition: 2, activeBuilds: 2, maxConcurrentBuilds: 2, waitingReason: 'slot' },
    ]
  );

  // 等待期间取消第 3 个构建任务
  abortController3.abort(new Error('用户取消构建等待'));
  await assert.rejects(p3, /用户取消构建等待/);
  assert.equal(limiter.getStats().waitingBuilds, 1);

  // 释放第 1 个槽位 -> 第 4 个任务立即补位执行
  d1.resolve();
  await p1;
  const res4 = await p4;
  assert.equal(res4, 'res-4');
  assert.ok(!executionOrder.includes('start-3'));
  assert.ok(executionOrder.includes('start-4'));

  d2.resolve();
  await p2;
  const statsAfter = limiter.getStats();
  assert.equal(statsAfter.activeBuilds, 0);
  assert.equal(statsAfter.waitingBuilds, 0);
  assert.equal(statsAfter.usedMemoryMb, 0);
});

test('内存预算池（带权信号量）：16GB 机器（14GB 预算池）下 3 个 6GB 构建最多同时跑 2 个，第 3 个等待内存释放', async () => {
  // 模拟 16GB 宿主机，预留 2GB 系统内存，构建内存预算池 = 14336MB (14GB)，槽位上限 4
  const limiter = createBuildSlotLimiter({
    maxConcurrent: 4,
    totalSystemMemoryMb: 16384,
    reservedSystemMemoryMb: 2048,
  });
  assert.equal(limiter.maxMemoryMb, 14336);

  const d1 = createDeferred();
  const d2 = createDeferred();
  const waitStages = [];
  const started = [];

  const p1 = limiter.withBuildSlot(
    async () => {
      started.push('b1');
      await d1.promise;
      return 'done-1';
    },
    { memoryMb: 6144 }
  );

  const p2 = limiter.withBuildSlot(
    async () => {
      started.push('b2');
      await d2.promise;
      return 'done-2';
    },
    { memoryMb: 6144 }
  );

  const p3 = limiter.withBuildSlot(
    async () => {
      started.push('b3');
      return 'done-3';
    },
    {
      memoryMb: 6144,
      onWait: (info) => {
        waitStages.push({ event: 'wait', ...info, formatted: formatBuildWaitStage(info) });
      },
    }
  );

  // 前 2 个 6GB 构建占用 12288MB，剩余 2048MB < 6144MB，第 3 个因内存不足进入等待
  assert.deepEqual(started, ['b1', 'b2']);
  const midStats = limiter.getStats();
  assert.equal(midStats.activeBuilds, 2);
  assert.equal(midStats.waitingBuilds, 1);
  assert.equal(midStats.usedMemoryMb, 12288);
  assert.equal(midStats.availableMemoryMb, 2048);
  assert.equal(waitStages.length, 1);
  assert.equal(waitStages[0].waitingReason, 'memory');
  assert.equal(waitStages[0].formatted.message, '等待构建资源（内存）…');
  assert.match(waitStages[0].formatted.detail, /需 6GB 内存，预算池可用 2\/14GB/);

  // 第 1 个 6GB 构建完成归还内存 -> 池剩余 8192MB >= 6144MB，第 3 个立即启动并完成
  d1.resolve();
  await p1;
  const res3 = await p3;
  assert.equal(res3, 'done-3');
  assert.deepEqual(started, ['b1', 'b2', 'b3']);

  d2.resolve();
  await p2;
  assert.equal(limiter.getStats().usedMemoryMb, 0);
  assert.equal(limiter.getStats().availableMemoryMb, 14336);
});

test('单次构建或扩容所需内存超过本机总预算池时立即快速失败，不进入无限排队', async () => {
  // 模拟 8GB 宿主机，预留 2GB 系统内存，构建内存预算池 = 6144MB (6GB)
  const limiter = createBuildSlotLimiter({
    maxConcurrent: 3,
    totalSystemMemoryMb: 8192,
    reservedSystemMemoryMb: 2048,
  });
  assert.equal(limiter.maxMemoryMb, 6144);

  let waitCalled = false;
  await assert.rejects(
    limiter.withBuildSlot(async () => 'never', {
      memoryMb: 8192,
      onWait: () => {
        waitCalled = true;
      },
    }),
    (err) => {
      assert.ok(err instanceof BuildMemoryBudgetExceededError);
      assert.equal(err.code, 'BUILD_MEMORY_BUDGET_EXCEEDED');
      assert.equal(err.message, '本机内存不足以构建该项目（需要 8 GB，可用 6 GB）');
      return true;
    }
  );
  assert.equal(waitCalled, false);
  assert.equal(limiter.getStats().waitingBuilds, 0);
});

test('OOM 扩容重试重新向同一内存预算池申请配额且同一时刻最多 1 个重试，目标记忆内存支持自动/下调/上调', async () => {
  // 默认堆上限保持 75% 物理内存规则（4096~8192MB），无历史数据时默认预占 3072MB（3GB）
  assert.ok(DEFAULT_BUILD_MAX_OLD_SPACE_MB >= 4096 && DEFAULT_BUILD_MAX_OLD_SPACE_MB <= 8192);
  assert.equal(resolveBuildHeapLimitMb({ command: 'pnpm build' }), DEFAULT_BUILD_MAX_OLD_SPACE_MB);
  assert.equal(resolveBuildMemoryRequirementMb({ command: 'pnpm build' }), DEFAULT_BUILD_INITIAL_RESERVE_MB);
  assert.equal(DEFAULT_BUILD_INITIAL_RESERVE_MB, 3072);
  assert.equal(
    resolveBuildMemoryRequirementMb({
      command: 'NODE_OPTIONS="--max-old-space-size=6144" pnpm build',
      defaultMaxOldSpaceMb: 8192,
    }),
    6144
  );
  // 有历史峰值时按 ceil(上次峰值 * 1.2) 预占，且不超过堆上限
  assert.equal(
    resolveBuildMemoryRequirementMb({
      command: 'pnpm build',
      targetBuildPeakMb: 5000,
      defaultMaxOldSpaceMb: 8192,
    }),
    6000
  );
  assert.equal(
    resolveBuildMemoryRequirementMb({
      command: 'pnpm build',
      targetBuildPeakMb: 7500,
      defaultMaxOldSpaceMb: 8192,
    }),
    8192
  );
  // 支持将目标构建内存显式改小（如从 8192 改回 4096 适配小内存服务器）
  assert.equal(
    resolveBuildMemoryRequirementMb({
      command: 'pnpm build',
      targetBuildMemoryMb: 4096,
      defaultMaxOldSpaceMb: 8192,
    }),
    4096
  );
  // 某目标上次 OOM 后用 8GB 成功并持久化了 targetBuildMemoryMb = 8192，下次直接返回 8192
  assert.equal(
    resolveBuildMemoryRequirementMb({
      command: 'pnpm build',
      targetBuildMemoryMb: 8192,
      defaultMaxOldSpaceMb: 4096,
    }),
    8192
  );
  assert.equal(resolveOomRetryMaxOldSpaceMb(4096, 14336), 8192);

  // 模拟 20GB 预算池，验证同一时刻最多允许 1 个 isOomRetry 任务运行
  const limiter = createBuildSlotLimiter({
    maxConcurrent: 4,
    maxMemoryMb: 20480,
    maxConcurrentOomRetries: 1,
  });
  const dRetry1 = createDeferred();
  const retryWaitReasons = [];

  const r1 = limiter.withBuildSlot(
    async () => {
      await dRetry1.promise;
      return 'retry-1';
    },
    { memoryMb: 8192, isOomRetry: true }
  );

  const r2 = limiter.withBuildSlot(
    async () => 'retry-2',
    {
      memoryMb: 8192,
      isOomRetry: true,
      onWait: (info) => retryWaitReasons.push(info.waitingReason),
    }
  );

  assert.equal(limiter.getStats().activeOomRetries, 1);
  assert.deepEqual(retryWaitReasons, ['oom-retry']);

  dRetry1.resolve();
  await Promise.all([r1, r2]);
  assert.equal(limiter.getStats().activeOomRetries, 0);
});

test('队首等待大内存的任务被取消后，立即唤醒后续可满足可用内存的任务（A 占 8GB、H 等 8GB 被取消、W 需 4GB 立即放行）', async () => {
  // 16GB 机器（14GB 预算池 = 14336MB），A 占 8GB（剩余 6GB），H 等 8GB 排第 1，W 需 4GB 排第 2
  const limiter = createBuildSlotLimiter({
    maxConcurrent: 4,
    totalSystemMemoryMb: 16384,
    reservedSystemMemoryMb: 2048,
  });
  const dA = createDeferred();
  const dW = createDeferred();
  const events = [];

  const pA = limiter.withBuildSlot(
    async () => {
      events.push('A-start');
      await dA.promise;
      events.push('A-end');
      return 'A';
    },
    { memoryMb: 8192 }
  );

  const abortH = new AbortController();
  const pH = limiter.withBuildSlot(
    async () => {
      events.push('H-start');
      return 'H';
    },
    {
      memoryMb: 8192,
      signal: abortH.signal,
      onWait: () => events.push('H-wait'),
    }
  );

  const pW = limiter.withBuildSlot(
    async () => {
      events.push('W-start');
      await dW.promise;
      events.push('W-end');
      return 'W';
    },
    {
      memoryMb: 4096,
      onWait: () => events.push('W-wait'),
    }
  );

  assert.deepEqual(events, ['A-start', 'H-wait', 'W-wait']);
  assert.equal(limiter.getStats().activeBuilds, 1);
  assert.equal(limiter.getStats().waitingBuilds, 2);

  // 取消队首 H -> 剩余可用内存 6GB 足够 W（4GB）运行，W 必须立即启动而不必等 A 结束
  abortH.abort(new Error('取消队首 H'));
  await assert.rejects(pH, /取消队首 H/);

  // 让微任务队列推进一次，确认 A 尚未结束时 W 已经启动
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(events.includes('W-start'), '取消 H 后 W 应立即被唤醒并开始执行');
  assert.ok(!events.includes('A-end'), '此时 A 仍在运行中');
  assert.equal(limiter.getStats().activeBuilds, 2);
  assert.equal(limiter.getStats().usedMemoryMb, 8192 + 4096);
  assert.equal(limiter.getStats().waitingBuilds, 0);

  dW.resolve();
  dA.resolve();
  await Promise.all([pA, pW]);
  assert.equal(limiter.getStats().activeBuilds, 0);
  assert.equal(limiter.getStats().usedMemoryMb, 0);
});

test('完整 OOM 重试链路：8GB 机器（6GB 预算池）下重试堆自动取 min(目标值, 池上限)=6GB，无法扩容时抛出明确错误', async () => {
  // 模拟 8GB 机器（总内存 8192MB，预留 2048MB，预算池上限 6144MB = 6GB）
  const limiter = createBuildSlotLimiter({
    maxConcurrent: 3,
    totalSystemMemoryMb: 8192,
    reservedSystemMemoryMb: 2048,
  });
  assert.equal(limiter.maxMemoryMb, 6144);

  const attemptHeaps = [];
  const stageLog = [];
  let persistedMemoryMb = 0;

  // 1. 首次 4096MB 触发 Node OOM -> 释放 4096MB -> 计算重试堆 min(8192, 6144) = 6144MB -> 重试成功并持久化 6144MB
  const retryResult = await executeBuildWithOomRetry({
    initialHeapMb: 4096,
    limiter,
    onBeforeRetry: (initMb, retryMb) => {
      stageLog.push(`before-retry:${initMb}->${retryMb}`);
    },
    runBuild: async (heapMb, isRetry) => {
      attemptHeaps.push({
        heapMb,
        isRetry,
        usedMemoryDuringRun: limiter.getStats().usedMemoryMb,
      });
      if (!isRetry) {
        throw new Error('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory');
      }
    },
    onRetrySuccess: async (retryMb) => {
      persistedMemoryMb = retryMb;
    },
  });

  assert.deepEqual(retryResult, {
    retried: true,
    usedHeapMb: 6144,
    peakRssMb: 0,
    initialReserveMb: 4096,
  });
  assert.deepEqual(stageLog, ['before-retry:4096->6144']);
  assert.deepEqual(attemptHeaps, [
    { heapMb: 4096, isRetry: false, usedMemoryDuringRun: 4096 },
    { heapMb: 6144, isRetry: true, usedMemoryDuringRun: 6144 },
  ]);
  assert.equal(persistedMemoryMb, 6144);
  assert.equal(limiter.getStats().usedMemoryMb, 0);

  // 2. 若初始构建已使用 6144MB（6GB）且池上限只有 6144MB（6GB），OOM 后无法继续扩容，明确报错且保留原 OOM 信息
  await assert.rejects(
    executeBuildWithOomRetry({
      initialHeapMb: 6144,
      limiter,
      runBuild: async () => {
        throw new Error('FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory');
      },
    }),
    (err) => {
      assert.ok(err instanceof BuildOomCannotExpandError);
      assert.equal(err.code, 'BUILD_OOM_CANNOT_EXPAND');
      assert.match(err.message, /已 OOM（6 GB），池上限只有 6 GB，无法扩容/);
      assert.match(err.message, /JavaScript heap out of memory/);
      return true;
    }
  );
  assert.equal(limiter.getStats().usedMemoryMb, 0);
});

test('16GB 机器同时构建 4 个大项目（每个需 6GB 堆）时按内存预算池（14GB）分两波平稳调度，峰值绝不超池上限', async () => {
  const limiter = createBuildSlotLimiter({
    maxConcurrent: 4,
    totalSystemMemoryMb: 16384,
    reservedSystemMemoryMb: 2048,
  });
  assert.equal(limiter.maxMemoryMb, 14336);

  const deferreds = [createDeferred(), createDeferred(), createDeferred(), createDeferred()];
  let peakUsedMemoryMb = 0;
  let peakActiveBuilds = 0;
  const startedProjects = [];

  const tasks = deferreds.map((d, idx) =>
    limiter.withBuildSlot(
      async () => {
        startedProjects.push(`project-${idx + 1}`);
        const stats = limiter.getStats();
        peakUsedMemoryMb = Math.max(peakUsedMemoryMb, stats.usedMemoryMb);
        peakActiveBuilds = Math.max(peakActiveBuilds, stats.activeBuilds);
        await d.promise;
        return `done-${idx + 1}`;
      },
      { memoryMb: 6144 }
    )
  );

  // 第 1 波：仅 project-1、project-2 启动（共 12GB <= 14GB），project-3、project-4 在等待队列
  assert.deepEqual(startedProjects, ['project-1', 'project-2']);
  assert.equal(limiter.getStats().activeBuilds, 2);
  assert.equal(limiter.getStats().waitingBuilds, 2);
  assert.equal(limiter.getStats().usedMemoryMb, 12288);

  // 完成第 1 波 -> 第 2 波 project-3、project-4 自动启动
  deferreds[0].resolve();
  deferreds[1].resolve();
  await Promise.all([tasks[0], tasks[1]]);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(startedProjects, ['project-1', 'project-2', 'project-3', 'project-4']);
  assert.equal(limiter.getStats().activeBuilds, 2);
  assert.equal(limiter.getStats().waitingBuilds, 0);

  deferreds[2].resolve();
  deferreds[3].resolve();
  await Promise.all(tasks);

  assert.ok(peakUsedMemoryMb <= 14336, `峰值预占内存 ${peakUsedMemoryMb}MB 不应超过预算池 14336MB`);
  assert.equal(peakActiveBuilds, 2);
  assert.equal(limiter.getStats().usedMemoryMb, 0);
});

test('容器 cgroup v2/v1 内存限制识别与小内存机器（<6GB）系统预留保护', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-cgroup-test-'));
  try {
    const v2File = path.join(tmpDir, 'memory.max');
    const v1File = path.join(tmpDir, 'memory.limit_in_bytes');

    // 1. 宿主机 32GB，但容器 cgroup v2 限制为 8GB -> 识别为 8192MB
    await fs.writeFile(v2File, String(8 * 1024 * 1024 * 1024), 'utf8');
    assert.equal(
      detectSystemMemoryMb({
        hostTotalBytes: 32 * 1024 * 1024 * 1024,
        cgroupV2Path: v2File,
        cgroupV1Path: v1File,
      }),
      8192
    );

    // 2. cgroup v2 为 "max"，cgroup v1 限制为 4GB -> 识别为 4096MB
    await fs.writeFile(v2File, 'max\n', 'utf8');
    await fs.writeFile(v1File, String(4 * 1024 * 1024 * 1024), 'utf8');
    assert.equal(
      detectSystemMemoryMb({
        hostTotalBytes: 32 * 1024 * 1024 * 1024,
        cgroupV2Path: v2File,
        cgroupV1Path: v1File,
      }),
      4096
    );

    // 3. 4GB 机器（4096MB）扣除 2048MB 系统预留后，池上限为 2048MB（不会强行抬到 4096MB 吃掉系统预留）
    const smallLimiter = createBuildSlotLimiter({
      totalSystemMemoryMb: 4096,
      reservedSystemMemoryMb: 2048,
    });
    assert.equal(smallLimiter.maxMemoryMb, 2048);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('buildIsolatedCommandEnv 注入自适应大内存上限、标准线程池与 CI 标志且不覆盖已有配置', () => {
  const defaultEnv = buildIsolatedCommandEnv({ CUSTOM_VAR: '1', NODE_OPTIONS: '' });
  assert.equal(defaultEnv.CUSTOM_VAR, '1');
  assert.equal(defaultEnv.CI, 'true');
  assert.equal(defaultEnv.UV_THREADPOOL_SIZE, '4');
  assert.ok(DEFAULT_BUILD_MAX_OLD_SPACE_MB >= 4096 && DEFAULT_BUILD_MAX_OLD_SPACE_MB <= 8192);
  assert.ok(FALLBACK_RETRY_MAX_OLD_SPACE_MB >= 8192);
  assert.match(defaultEnv.NODE_OPTIONS, new RegExp(`--max-old-space-size=${DEFAULT_BUILD_MAX_OLD_SPACE_MB}`));

  // 保留已有的其他 NODE_OPTIONS 参数并追加堆上限
  const mergedNodeOpts = buildIsolatedCommandEnv({ NODE_OPTIONS: '--no-warnings' }, { maxOldSpaceMb: 3072 });
  assert.equal(mergedNodeOpts.NODE_OPTIONS, '--no-warnings --max-old-space-size=3072');

  // 已显式配置 --max-old-space-size 时不重复追加
  const customHeapEnv = buildIsolatedCommandEnv({ NODE_OPTIONS: '--max-old-space-size=8192' });
  assert.equal(customHeapEnv.NODE_OPTIONS, '--max-old-space-size=8192');

  // 支持从命令文本中自动提取内联 NODE_OPTIONS 并跨 && 生效
  const inlineCmdEnv = buildIsolatedCommandEnv(
    { NODE_OPTIONS: '' },
    { command: 'NODE_OPTIONS="--max-old-space-size=8192" cd packages && pnpm build' }
  );
  assert.equal(inlineCmdEnv.NODE_OPTIONS, '--max-old-space-size=8192');

  // 后端 Maven 构建关闭 Node 堆限制注入
  const mavenEnv = buildIsolatedCommandEnv({ NODE_OPTIONS: '' }, { injectNodeHeapLimit: false });
  assert.equal(mavenEnv.NODE_OPTIONS, '');
  assert.equal(mavenEnv.CI, 'true');
});

test('extractInlineCommandEnv 正确剥离前导与多段命令中的环境变量赋值', () => {
  assert.deepEqual(
    extractInlineCommandEnv('NODE_OPTIONS="--max-old-space-size=4096" pnpm build'),
    {
      envVars: { NODE_OPTIONS: '--max-old-space-size=4096' },
      cleanedCommand: 'pnpm build',
    }
  );
  assert.deepEqual(
    extractInlineCommandEnv('NODE_OPTIONS="--max-old-space-size=8192" cd packages && pnpm build'),
    {
      envVars: { NODE_OPTIONS: '--max-old-space-size=8192' },
      cleanedCommand: 'cd packages && pnpm build',
    }
  );
  assert.deepEqual(
    extractInlineCommandEnv('cd packages && cross-env NODE_OPTIONS="--max-old-space-size=6144" pnpm build'),
    {
      envVars: { NODE_OPTIONS: '--max-old-space-size=6144' },
      cleanedCommand: 'cd packages && pnpm build',
    }
  );
  assert.deepEqual(
    extractInlineCommandEnv('export NODE_OPTIONS="--max-old-space-size=8192" && pnpm build'),
    {
      envVars: { NODE_OPTIONS: '--max-old-space-size=8192' },
      cleanedCommand: 'pnpm build',
    }
  );
});

test('applyLowProcessPriority 对无效 PID 安全降级不抛异常', () => {
  assert.equal(applyLowProcessPriority(0), false);
  assert.equal(applyLowProcessPriority(-1), false);
  assert.equal(applyLowProcessPriority(undefined), false);
});

test('按实际峰值预占：无历史数据时 16GB 机器可同时跑 4 个构建；记录峰值后按 1.2 倍预占；重试时先释放再申请', async () => {
  // 16GB 机器（14336MB 预算池），4 个并发槽位
  const limiter = createBuildSlotLimiter({
    maxConcurrent: 4,
    totalSystemMemoryMb: 16384,
    reservedSystemMemoryMb: 2048,
  });
  assert.equal(limiter.maxMemoryMb, 14336);

  // 1. 无历史数据时，每个构建预占 3072MB（3GB），4 个合计 12288MB <= 14336MB，4 个全部同时运行不排队
  const deferreds = [createDeferred(), createDeferred(), createDeferred(), createDeferred()];
  const started = [];
  const waitEvents = [];

  const fourTasks = deferreds.map((d, idx) => {
    const reserveMb = resolveBuildMemoryRequirementMb({
      command: 'pnpm build',
      targetBuildMemoryMb: 0,
      targetBuildPeakMb: 0,
      defaultMaxOldSpaceMb: 8192,
    });
    assert.equal(reserveMb, 3072);
    return limiter.withBuildSlot(
      async (slotCtx) => {
        started.push(`p${idx + 1}`);
        slotCtx.reportPeakRssMb(idx === 0 ? 5000 : 1800);
        await d.promise;
        return `ok-${idx + 1}`;
      },
      {
        memoryMb: reserveMb,
        heapLimitMb: 8192,
        targetId: idx + 1,
        label: `project-${idx + 1}`,
        onWait: (info) => waitEvents.push(info),
      }
    );
  });

  // 4 个任务立即同时进入运行态，无任何排队
  assert.deepEqual(started, ['p1', 'p2', 'p3', 'p4']);
  assert.equal(waitEvents.length, 0);
  const statsActive = limiter.getStats();
  assert.equal(statsActive.activeBuilds, 4);
  assert.equal(statsActive.usedMemoryMb, 12288);
  assert.equal(statsActive.activeBuildDetails.length, 4);
  assert.equal(statsActive.activeBuildDetails[0].reservedMemoryMb, 3072);
  assert.equal(statsActive.activeBuildDetails[0].peakRssMb, 5000);

  deferreds.forEach((d) => d.resolve());
  await Promise.all(fourTasks);

  const statsAfterFour = limiter.getStats();
  assert.equal(statsAfterFour.activeBuilds, 0);
  assert.equal(statsAfterFour.usedMemoryMb, 0);
  assert.equal(statsAfterFour.recentBuilds.length, 4);

  // 2. 项目 1 记录了峰值 5000MB 后，下次预占 ceil(5000 * 1.2) = 6000MB
  const nextReserveP1 = resolveBuildMemoryRequirementMb({
    command: 'pnpm build',
    targetBuildPeakMb: 5000,
    defaultMaxOldSpaceMb: 8192,
  });
  assert.equal(nextReserveP1, 6000);

  // 3. OOM 重试时，先释放初始 3072MB 预占，再按重试值（8192MB）重新申请，且无论成功/失败均通过 onFinally 汇报峰值
  const otherTaskDeferred = createDeferred();
  // 先让另一个任务占用 7000MB（池剩余 7336MB，足够初始 3072MB，但不够重试 8192MB）
  const pHolder = limiter.withBuildSlot(
    async () => {
      await otherTaskDeferred.promise;
    },
    { memoryMb: 7000 }
  );

  const oomEvents = [];
  let finallySummary = null;
  const pOom = executeBuildWithOomRetry({
    initialHeapMb: 6144,
    initialReserveMb: 3072,
    limiter,
    targetId: 99,
    label: 'oom-project',
    onRetryWait: (info) => {
      // 关键断言：进入重试等待时，初始的 3072MB 必须已经释放！此时 usedMemoryMb 只剩 pHolder 的 7000MB
      oomEvents.push({
        phase: 'retry-wait',
        usedMemoryMb: info.usedMemoryMb,
        requestedMemoryMb: info.requestedMemoryMb,
      });
      otherTaskDeferred.resolve();
    },
    runBuild: async (heapMb, isRetry, slotCtx) => {
      oomEvents.push({
        phase: isRetry ? 'retry-run' : 'initial-run',
        heapMb,
        reservedMemoryMb: slotCtx.reservedMemoryMb,
        poolUsedMemoryMb: limiter.getStats().usedMemoryMb,
      });
      slotCtx.reportPeakRssMb(isRetry ? 6800 : 5900);
      if (!isRetry) {
        throw new Error('FATAL ERROR: JavaScript heap out of memory');
      }
    },
    onFinally: async (summary) => {
      finallySummary = summary;
    },
  });

  await Promise.all([pHolder, pOom]);
  assert.deepEqual(oomEvents, [
    { phase: 'initial-run', heapMb: 6144, reservedMemoryMb: 3072, poolUsedMemoryMb: 10072 },
    { phase: 'retry-wait', usedMemoryMb: 7000, requestedMemoryMb: 8192 },
    { phase: 'retry-run', heapMb: 8192, reservedMemoryMb: 8192, poolUsedMemoryMb: 8192 },
  ]);
  assert.deepEqual(finallySummary, {
    peakRssMb: 6800,
    initialReserveMb: 3072,
    usedHeapMb: 8192,
    retried: true,
    succeeded: true,
  });
});

test('进程树 RSS 采样覆盖 pnpm/npm 拉起的多级子进程，构建失败时同样通过 onFinally 记录峰值且写库异常不吞原始构建报错', async () => {
  // 1. 验证 ps 输出解析覆盖多级子进程树（sh -> pnpm -> node -> vite-worker）及同进程组进程
  const mockPsOutput = [
    '  100     1   100   4096', // 无关进程
    '  200   100   200   2048', // 构建根进程 sh (pid=200, pgid=200, 2MB)
    '  201   200   200  51200', // 子进程 pnpm (pid=201, ppid=200, 50MB)
    '  202   201   200 409600', // 孙进程 node vite (pid=202, ppid=201, 400MB)
    '  203   202   203 102400', // 曾孙进程 esbuild (pid=203, ppid=202, 独立 pgid=203, 100MB)
    '  300   100   300  99999', // 其他无关构建进程
  ].join('\n');

  const treeRssMb = parsePsOutputToProcessTreeRssMb(mockPsOutput, 200);
  // 2 + 50 + 400 + 100 = 552 MB
  assert.equal(treeRssMb, 552);

  // 2. 验证真实当前进程采样与周期采样器 createProcessTreeRssSampler
  const selfRssMb = await sampleProcessTreeRssMb(process.pid);
  if (process.platform !== 'win32') {
    assert.ok(selfRssMb > 0, `期望当前 Node 进程树 RSS > 0，实际为 ${selfRssMb}MB`);
  }

  let sampleIdx = 0;
  const fakeReadings = [1200, 3400, 2800];
  const observedPeaks = [];
  const sampler = createProcessTreeRssSampler(99999, {
    intervalMs: 25,
    sampleFn: async () => fakeReadings[Math.min(sampleIdx++, fakeReadings.length - 1)],
    onPeak: (peakMb) => observedPeaks.push(peakMb),
  });
  await new Promise((resolve) => setTimeout(resolve, 70));
  const finalPeak = await sampler.stop();
  assert.equal(finalPeak, 3400);
  assert.ok(observedPeaks.includes(3400));

  // 3. 验证构建失败（非 OOM 业务报错）时，onFinally 拿到 succeeded: false 与峰值，且 onFinally 抛错不会吞掉原始构建错误
  const limiter = createBuildSlotLimiter({ maxConcurrent: 2, maxMemoryMb: 14336 });
  let failedSummary = null;
  await assert.rejects(
    executeBuildWithOomRetry({
      initialHeapMb: 8192,
      initialReserveMb: 3072,
      limiter,
      runBuild: async (_heapMb, _isRetry, slotCtx) => {
        slotCtx.reportPeakRssMb(4250);
        throw new Error('TypeScript compile error: TS2322');
      },
      onFinally: async (summary) => {
        failedSummary = summary;
        throw new Error('SQLite write peak failed: disk full');
      },
    }),
    /TS2322/
  );
  assert.deepEqual(failedSummary, {
    peakRssMb: 4250,
    initialReserveMb: 3072,
    usedHeapMb: 8192,
    retried: false,
    succeeded: false,
  });
});
