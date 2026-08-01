import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * 在隔离进程中执行服务器排序脚本。
 * @param {string} root 临时数据目录
 * @param {string} source 脚本源码
 * @returns {any} 脚本最后一行输出的 JSON
 */
function runStoreScript(root, source) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DEPLOY_DATA_DIR: root,
      DEPLOY_DB_PATH: path.join(root, 'deploy.sqlite'),
      DEPLOY_SECRET_KEY: 'server-order-test-secret',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.trim().split('\n').filter(Boolean).at(-1);
  return line ? JSON.parse(line) : null;
}

test('服务器拖拽顺序可持久化，并拒绝过期或重复的排序数据', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-server-order-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = runStoreScript(root, `
    const store = await import('./server/services/deploy-store.mjs');
    const create = (name, host) => store.createServer({
      name,
      host,
      port: 22,
      username: 'guest',
      authType: 'password',
      password: 'test-password',
    });
    const first = await create('第一台', '10.0.0.1');
    const second = await create('第二台', '10.0.0.2');
    const third = await create('第三台', '10.0.0.3');
    const initial = (await store.listServers()).map((item) => item.name);
    const reordered = await store.reorderServers([third.id, first.id, second.id]);
    let duplicateError = '';
    try {
      await store.reorderServers([third.id, third.id, second.id]);
    } catch (error) {
      duplicateError = error.message;
    }
    await store.closeDeployDb();
    console.log(JSON.stringify({
      initial,
      reordered: reordered.map((item) => ({ name: item.name, sortOrder: item.sortOrder })),
      duplicateError,
    }));
  `);

  assert.deepEqual(result.initial, ['第一台', '第二台', '第三台']);
  assert.deepEqual(result.reordered, [
    { name: '第三台', sortOrder: 1 },
    { name: '第一台', sortOrder: 2 },
    { name: '第二台', sortOrder: 3 },
  ]);
  assert.match(result.duplicateError, /重复项/);

  const persisted = runStoreScript(root, `
    const store = await import('./server/services/deploy-store.mjs');
    const servers = await store.listServers();
    await store.closeDeployDb();
    console.log(JSON.stringify(servers.map((item) => item.name)));
  `);
  assert.deepEqual(persisted, ['第三台', '第一台', '第二台']);
});
