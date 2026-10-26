import assert from 'node:assert/strict';
import test from 'node:test';

process.env.YUYAN_BACKEND_STATUS_TTL_MS = '200';
process.env.YUYAN_BACKEND_STATUS_ERROR_TTL_MS = '100';
process.env.YUYAN_BACKEND_STATUS_PER_SERVER = '2';
process.env.YUYAN_BACKEND_STATUS_GLOBAL = '3';

const cache = await import('../backend-status-cache.mjs');
const { buildBackendStatusProbeCommand, parseBackendStatusProbeOutput } = await import('../backend-runtime-service.mjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('多人并发查询同一目标只探测一次，TTL 内复用缓存', async () => {
  cache.resetBackendStatusCache();
  let probes = 0;
  const loader = async () => {
    probes += 1;
    await sleep(30);
    return { status: 'online' };
  };
  const results = await Promise.all(Array.from({ length: 10 }, () => cache.getOrProbeBackendStatus({ scope: 't', targetId: 1 }, loader)));
  assert.equal(probes, 1);
  assert.ok(results.every((item) => item.status === 'online'));

  const cached = await cache.getOrProbeBackendStatus({ scope: 't', targetId: 1 }, loader);
  assert.equal(cached.cached, true);
  assert.equal(probes, 1);

  await sleep(220);
  await cache.getOrProbeBackendStatus({ scope: 't', targetId: 1 }, loader);
  assert.equal(probes, 2, 'TTL 过期后重新探测');
});

test('fresh 绕过缓存，不同团队互不共享', async () => {
  cache.resetBackendStatusCache();
  let probes = 0;
  const loader = async () => ({ status: 'online', n: ++probes });
  await cache.getOrProbeBackendStatus({ scope: 'a', targetId: 1 }, loader);
  await cache.getOrProbeBackendStatus({ scope: 'b', targetId: 1 }, loader);
  assert.equal(probes, 2);
  const fresh = await cache.getOrProbeBackendStatus({ scope: 'a', targetId: 1, fresh: true }, loader);
  assert.equal(fresh.cached, false);
  assert.equal(probes, 3);
});

test('探测失败短期退避，避免不可达服务器被反复 SSH', async () => {
  cache.resetBackendStatusCache();
  let probes = 0;
  const loader = async () => {
    probes += 1;
    throw new Error('SSH 连接超时');
  };
  await assert.rejects(cache.getOrProbeBackendStatus({ scope: 't', targetId: 2 }, loader), /SSH 连接超时/);
  await assert.rejects(cache.getOrProbeBackendStatus({ scope: 't', targetId: 2 }, loader), /SSH 连接超时/);
  assert.equal(probes, 1, '退避期内直接返回缓存的失败');
  await sleep(120);
  await assert.rejects(cache.getOrProbeBackendStatus({ scope: 't', targetId: 2 }, loader));
  assert.equal(probes, 2);
});

test('同步抛错的探测函数不会残留进行中的任务', async () => {
  cache.resetBackendStatusCache();
  await assert.rejects(
    cache.getOrProbeBackendStatus({ scope: 't', targetId: 3, fresh: true }, () => {
      throw new Error('上下文无效');
    }),
    /上下文无效/
  );
  assert.equal(cache.getBackendStatusCacheStats().inflight, 0);
});

test('失效后丢弃旧探测结果，新请求不合并到失效前的探测', async () => {
  cache.resetBackendStatusCache();
  let release;
  const slowOld = new Promise((resolve) => {
    release = resolve;
  });
  const oldProbe = cache.getOrProbeBackendStatus({ scope: 't', targetId: 4 }, async () => {
    await slowOld;
    return { status: 'online' };
  });
  cache.invalidateBackendStatus('t', 4);
  const newProbe = await cache.getOrProbeBackendStatus({ scope: 't', targetId: 4 }, async () => ({ status: 'offline' }));
  assert.equal(newProbe.status, 'offline');
  release();
  assert.equal((await oldProbe).status, 'online');
  const afterOld = await cache.getOrProbeBackendStatus({ scope: 't', targetId: 4 }, async () => ({ status: 'error' }));
  assert.equal(afterOld.status, 'offline', '旧探测晚返回不能覆盖失效后的新结果');
  assert.equal(afterOld.cached, true);
});

test('服务器级与全局并发上限生效', async () => {
  let active = 0;
  let maxActive = 0;
  const perServerActive = new Map();
  const perServerMax = new Map();
  const task = (serverId) =>
    cache.runWithProbeLimit(serverId, async () => {
      active += 1;
      perServerActive.set(serverId, (perServerActive.get(serverId) || 0) + 1);
      maxActive = Math.max(maxActive, active);
      perServerMax.set(serverId, Math.max(perServerMax.get(serverId) || 0, perServerActive.get(serverId)));
      await sleep(20);
      active -= 1;
      perServerActive.set(serverId, perServerActive.get(serverId) - 1);
    });
  await Promise.all([...Array.from({ length: 6 }, () => task(1)), ...Array.from({ length: 6 }, () => task(2)), ...Array.from({ length: 6 }, () => task(3))]);
  assert.ok(maxActive <= 3, `全局并发 ${maxActive} 超过上限`);
  for (const value of perServerMax.values()) assert.ok(value <= 2, `单服务器并发 ${value} 超过上限`);
  assert.equal(cache.getBackendStatusCacheStats().serverGates, 0, '空闲后释放服务器闸门');
});

test('只读探测命令不包含目录创建、Java 检测与文件写入', () => {
  const paths = { scriptPath: '/opt/backend/app/bin/service.sh' };
  const pidCommand = buildBackendStatusProbeCommand({ id: 7, serviceName: 'app', processMode: 'pid' }, paths);
  assert.match(pidCommand, /service\.sh'? status/);
  assert.doesNotMatch(pidCommand, /mkdir|java|-version|cat >|tee /);
  const systemdCommand = buildBackendStatusProbeCommand({ id: 7, serviceName: 'app', processMode: 'systemd' }, paths);
  assert.match(systemdCommand, /sudo -n true/);
  assert.match(systemdCommand, /systemctl is-active 'yuyan-7-app\.service'/);
  assert.match(systemdCommand, /service\.sh'? status/, '无免密 sudo 时回退 PID 脚本');
});

test('解析探测输出的模式标记', () => {
  assert.deepEqual(parseBackendStatusProbeOutput('__YUYAN_PROBE_MODE__=pid\nRUNNING: 123\n'), { mode: 'pid', stdout: 'RUNNING: 123', stderr: '' });
  assert.equal(parseBackendStatusProbeOutput('__YUYAN_PROBE_MODE__=systemd\nactive').mode, 'systemd');
  assert.equal(parseBackendStatusProbeOutput('__YUYAN_PROBE_MODE__=missing\n').mode, 'missing');
  assert.equal(parseBackendStatusProbeOutput('').mode, 'missing');
});
