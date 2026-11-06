import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppUpdateETagResolver } from '../app-update-etag.mjs';

const SHA_1 = '1111111111111111111111111111111111111111111111111111111111111111';
const SHA_2 = '2222222222222222222222222222222222222222222222222222222222222222';
const SHA_UPPER = 'ABCDEF0123456789'.repeat(4);
const SHA_LOWER = SHA_UPPER.toLowerCase();

test('app-update-etag：合法/非法/缺失', () => {
  // 合法 sha256（支持大写、前后首尾空白换行，归一化为小写）
  const resolve = createAppUpdateETagResolver({
    readFile: () => `  ${SHA_UPPER}\n`,
    statFile: () => ({ size: 66, mtimeMs: 1000 }),
  });
  assert.equal(resolve('/updates/app.zip', { size: 100, mtimeMs: 1000 }), `"sha256-${SHA_LOWER}"`);

  // 非法内容：not-a-sha256、63位、65位、非十六进制字符
  const testInvalid = (content) => {
    const r = createAppUpdateETagResolver({
      readFile: () => content,
      statFile: () => ({ size: content.length, mtimeMs: 1000 }),
    });
    assert.equal(r('/updates/app.zip', { size: 100, mtimeMs: 1000 }), null);
  };
  testInvalid('not-a-sha256');
  testInvalid('a'.repeat(63));
  testInvalid('a'.repeat(65));
  testInvalid('g'.repeat(64));

  // 缺失：statFile 抛错或 readFile 抛错
  const missingStat = createAppUpdateETagResolver({
    readFile: () => SHA_1,
    statFile: () => {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    },
  });
  assert.equal(missingStat('/updates/app.zip', { size: 100, mtimeMs: 1000 }), null);

  const missingRead = createAppUpdateETagResolver({
    readFile: () => {
      throw new Error('EACCES');
    },
    statFile: () => ({ size: 64, mtimeMs: 1000 }),
  });
  assert.equal(missingRead('/updates/app.zip', { size: 100, mtimeMs: 1000 }), null);
});

test('app-update-etag：同一 stat 下多次调用只读一次（Range 请求场景）', () => {
  let reads = 0;
  const resolve = createAppUpdateETagResolver({
    readFile: () => {
      reads += 1;
      return SHA_1;
    },
    statFile: () => ({ size: 64, mtimeMs: 1000 }),
  });

  const binStat = { size: 1024, mtimeMs: 1000 };
  for (let i = 0; i < 20; i += 1) {
    assert.equal(resolve('/updates/app.zip', binStat), `"sha256-${SHA_1}"`);
  }
  assert.equal(reads, 1, '同一 stat 下后续请求命中缓存，不重复读取磁盘');
});

test('app-update-etag：二进制 size 变 → 重新读取得到新 ETag', () => {
  let currentSha = SHA_1;
  let reads = 0;
  const resolve = createAppUpdateETagResolver({
    readFile: () => {
      reads += 1;
      return currentSha;
    },
    statFile: () => ({ size: 64, mtimeMs: 1000 }),
  });

  const etag1 = resolve('/updates/app.zip', { size: 100, mtimeMs: 1000 });
  assert.equal(etag1, `"sha256-${SHA_1}"`);
  assert.equal(reads, 1);

  // 二进制文件大小改变
  currentSha = SHA_2;
  const etag2 = resolve('/updates/app.zip', { size: 200, mtimeMs: 1000 });
  assert.equal(etag2, `"sha256-${SHA_2}"`);
  assert.equal(reads, 2);
  assert.notEqual(etag1, etag2);
});

test('app-update-etag：二进制 mtimeMs 变（size 不变）→ 重新读取', () => {
  let currentSha = SHA_1;
  let reads = 0;
  const resolve = createAppUpdateETagResolver({
    readFile: () => {
      reads += 1;
      return currentSha;
    },
    statFile: () => ({ size: 64, mtimeMs: 1000 }),
  });

  const etag1 = resolve('/updates/app.zip', { size: 100, mtimeMs: 1000 });
  assert.equal(etag1, `"sha256-${SHA_1}"`);
  assert.equal(reads, 1);

  // 二进制文件大小不变，修改时间变化
  currentSha = SHA_2;
  const etag2 = resolve('/updates/app.zip', { size: 100, mtimeMs: 2000 });
  assert.equal(etag2, `"sha256-${SHA_2}"`);
  assert.equal(reads, 2);
  assert.notEqual(etag1, etag2);
});

test('app-update-etag：sidecar mtime/size 变 → 重新读取', () => {
  let currentSha = SHA_1;
  let sidecarStat = { size: 64, mtimeMs: 1000 };
  let reads = 0;
  const resolve = createAppUpdateETagResolver({
    readFile: () => {
      reads += 1;
      return currentSha;
    },
    statFile: () => sidecarStat,
  });

  const binStat = { size: 100, mtimeMs: 1000 };
  const etag1 = resolve('/updates/app.zip', binStat);
  assert.equal(etag1, `"sha256-${SHA_1}"`);
  assert.equal(reads, 1);

  // sidecar mtimeMs 改变
  currentSha = SHA_2;
  sidecarStat = { size: 64, mtimeMs: 2000 };
  const etag2 = resolve('/updates/app.zip', binStat);
  assert.equal(etag2, `"sha256-${SHA_2}"`);
  assert.equal(reads, 2);

  // sidecar size 改变
  currentSha = SHA_1;
  sidecarStat = { size: 65, mtimeMs: 2000 };
  const etag3 = resolve('/updates/app.zip', binStat);
  assert.equal(etag3, `"sha256-${SHA_1}"`);
  assert.equal(reads, 3);
});

test('app-update-etag：sidecar 缺失不缓存（之后出现 sidecar 立刻生效）', () => {
  let sidecarExists = false;
  let reads = 0;
  const resolve = createAppUpdateETagResolver({
    readFile: () => {
      reads += 1;
      return SHA_1;
    },
    statFile: () => {
      if (!sidecarExists) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return { size: 64, mtimeMs: 1000 };
    },
  });

  const binStat = { size: 100, mtimeMs: 1000 };
  // sidecar 缺失时返回 null 且不写缓存
  assert.equal(resolve('/updates/app.zip', binStat), null);
  assert.equal(resolve('/updates/app.zip', binStat), null);
  assert.equal(reads, 0);

  // 随后 sidecar 出现，立刻生效
  sidecarExists = true;
  assert.equal(resolve('/updates/app.zip', binStat), `"sha256-${SHA_1}"`);
  assert.equal(reads, 1);
});

test('app-update-etag：stat 缺失时每次都读取（安全回退）', () => {
  let reads = 0;
  const resolve = createAppUpdateETagResolver({
    readFile: () => {
      reads += 1;
      return SHA_1;
    },
  });

  // 不传 stat 或 stat 为 undefined
  assert.equal(resolve('/updates/app.zip'), `"sha256-${SHA_1}"`);
  assert.equal(resolve('/updates/app.zip', undefined), `"sha256-${SHA_1}"`);
  assert.equal(resolve('/updates/app.zip', null), `"sha256-${SHA_1}"`);
  assert.equal(reads, 3, 'stat 缺失时不缓存，每次都直接读取');
});

test('app-update-etag：容量满按最早淘汰而非整体清空', () => {
  let reads = 0;
  const resolve = createAppUpdateETagResolver({
    maxEntries: 2,
    readFile: (p) => {
      reads += 1;
      return p.includes('1') ? SHA_1 : SHA_2;
    },
    statFile: () => ({ size: 64, mtimeMs: 1000 }),
  });

  const binStat = { size: 100, mtimeMs: 1000 };
  // 插入条目 1 和条目 2
  resolve('/updates/1.zip', binStat);
  resolve('/updates/2.zip', binStat);
  assert.equal(reads, 2);

  // 插入条目 3，容量满（maxEntries=2），此时最早插入的 1.zip 被淘汰，2.zip 仍保留
  resolve('/updates/3.zip', binStat);
  assert.equal(reads, 3);

  // 访问 2.zip：命中缓存，读盘次数不变！
  resolve('/updates/2.zip', binStat);
  assert.equal(reads, 3, '2.zip 仍在缓存中，未被整体清空淘汰');

  // 访问 1.zip：已被淘汰，触发重新读取
  resolve('/updates/1.zip', binStat);
  assert.equal(reads, 4, '1.zip 已被淘汰，需重新读取');
});

test('app-update-etag：真实临时文件集成用例（写入与 utimes 修改 mtime 触发重新解析）', async () => {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'yuyan-update-etag-test-'));
  try {
    const binPath = path.join(tmpDir, 'app.zip');
    const sidecarPath = `${binPath}.sha256`;

    await fsp.writeFile(binPath, 'dummy binary content v1');
    await fsp.writeFile(sidecarPath, `${SHA_1}\n`);

    const resolver = createAppUpdateETagResolver();

    const stat1 = fs.statSync(binPath);
    const etag1 = resolver(binPath, stat1);
    assert.equal(etag1, `"sha256-${SHA_1}"`);

    // 相同 stat 命中缓存
    const etag1Repeat = resolver(binPath, stat1);
    assert.equal(etag1Repeat, etag1);

    // 更新文件内容与 mtime
    await fsp.writeFile(binPath, 'dummy binary content v2 (updated)');
    await fsp.writeFile(sidecarPath, `${SHA_2}\n`);

    // 显式调整 mtime 确保时间戳不同
    const futureTime = Math.floor(Date.now() / 1000) + 10;
    fs.utimesSync(binPath, futureTime, futureTime);
    fs.utimesSync(sidecarPath, futureTime, futureTime);

    const stat2 = fs.statSync(binPath);
    const etag2 = resolver(binPath, stat2);
    assert.equal(etag2, `"sha256-${SHA_2}"`);
    assert.notEqual(etag1, etag2);
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
});
