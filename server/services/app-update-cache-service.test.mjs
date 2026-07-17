import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import {
  createUpdateAssetCacheManager,
  normalizeUpdateAsset,
  parseUpdateContentRange,
  validateUpdateAssetSignature,
} from './app-update-cache-service.mjs';

/** 创建带 MZ 文件头的测试 EXE 数据。 */
function createExePayload(size = 1024 * 1024 + 32) {
  const payload = Buffer.alloc(size, 0x5a);
  payload.write('MZ', 0, 'ascii');
  return payload;
}

/** 创建带 UDIF koly 尾部签名的测试 DMG 数据。 */
function createDmgPayload(size = 1024 * 1024 + 512) {
  const payload = Buffer.alloc(size, 0x44);
  payload.write('koly', size - 512, 'ascii');
  return payload;
}

/** 创建带 Gzip 文件头的 macOS updater 数据。 */
function createMacUpdaterPayload(size = 1024 * 1024 + 32) {
  const payload = Buffer.alloc(size, 0x41);
  payload[0] = 0x1f;
  payload[1] = 0x8b;
  return payload;
}

/** 计算测试数据 SHA-256。 */
function digestPayload(payload) {
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/** 创建测试缓存目录并在结束后清理。 */
async function withTempCache(run) {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-update-cache-'));
  try {
    await run(cacheDir);
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
}

test('更新资源身份拒绝目录穿越并规范化 GitHub digest', () => {
  assert.throws(
    () => normalizeUpdateAsset({ assetId: '1', filename: '../yuyan.exe' }),
    /文件名无效/
  );
  assert.deepEqual(
    normalizeUpdateAsset({
      assetId: 123,
      filename: 'yuyan.exe',
      size: 10,
      digest: `sha256:${'a'.repeat(64)}`,
    }),
    {
      assetId: '123',
      filename: 'yuyan.exe',
      size: 10,
      sha256: 'a'.repeat(64),
      etag: '',
    }
  );
});

test('Content-Range 只接受完整有效的字节范围', () => {
  assert.deepEqual(parseUpdateContentRange('bytes 10-19/20'), { start: 10, end: 19, total: 20 });
  assert.equal(parseUpdateContentRange('bytes 20-19/20'), null);
  assert.equal(parseUpdateContentRange('bytes */20'), null);
});

test('EXE 缓存必须包含 MZ 文件头且大于最小体积', async () => {
  await withTempCache(async (cacheDir) => {
    const validPath = path.join(cacheDir, 'valid.exe');
    const invalidPath = path.join(cacheDir, 'invalid.exe');
    await fs.writeFile(validPath, createExePayload());
    await fs.writeFile(invalidPath, Buffer.alloc(1024 * 1024 + 32));
    assert.equal(validateUpdateAssetSignature(validPath, 'valid.exe'), true);
    assert.equal(validateUpdateAssetSignature(invalidPath, 'invalid.exe'), false);
  });
});

test('DMG 缓存必须包含 UDIF koly 尾部签名', async () => {
  await withTempCache(async (cacheDir) => {
    const validPath = path.join(cacheDir, 'valid.dmg');
    const invalidPath = path.join(cacheDir, 'invalid.dmg');
    await fs.writeFile(validPath, createDmgPayload());
    await fs.writeFile(invalidPath, Buffer.alloc(1024 * 1024 + 512));
    assert.equal(validateUpdateAssetSignature(validPath, 'valid.dmg'), true);
    assert.equal(validateUpdateAssetSignature(invalidPath, 'invalid.dmg'), false);
  });
});

test('macOS Updater 缓存必须包含 Gzip 文件头', async () => {
  await withTempCache(async (cacheDir) => {
    const validPath = path.join(cacheDir, 'valid.app.tar.gz');
    const invalidPath = path.join(cacheDir, 'invalid.app.tar.gz');
    await fs.writeFile(validPath, createMacUpdaterPayload());
    await fs.writeFile(invalidPath, Buffer.alloc(1024 * 1024 + 32));
    assert.equal(validateUpdateAssetSignature(validPath, 'valid.app.tar.gz'), true);
    assert.equal(validateUpdateAssetSignature(invalidPath, 'invalid.app.tar.gz'), false);
  });
});

test('并发预热同一 asset 只创建一个 GitHub 下载任务', async () => {
  await withTempCache(async (cacheDir) => {
    const payload = createExePayload();
    let requestCount = 0;
    const manager = createUpdateAssetCacheManager({
      cacheDir,
      githubRepo: 'test/repo',
      getGithubToken: () => 'test-token',
      downloadClient: async () => {
        requestCount += 1;
        return {
          status: 200,
          headers: {
            'content-length': String(payload.length),
            'etag': '"asset-v1"',
          },
          data: Readable.from([payload.subarray(0, 4096), payload.subarray(4096)]),
        };
      },
    });
    const asset = {
      assetId: '101',
      filename: 'yuyan.exe',
      size: payload.length,
      sha256: digestPayload(payload),
    };

    const [first, second] = await Promise.all([
      manager.ensureCached(asset),
      manager.ensureCached(asset),
    ]);
    assert.equal(first.status, 'preparing');
    assert.equal(second.status, 'preparing');
    const completed = await manager.waitForAsset(asset, 5000);
    assert.equal(completed.status, 'ready');
    assert.equal(requestCount, 1);
  });
});

test('服务端预下载会从稳定 part 文件断点续传并校验后原子落盘', async () => {
  await withTempCache(async (cacheDir) => {
    const payload = createExePayload();
    const offset = 256 * 1024;
    let receivedRange = '';
    let receivedIfRange = '';
    const manager = createUpdateAssetCacheManager({
      cacheDir,
      githubRepo: 'test/repo',
      getGithubToken: () => 'test-token',
      downloadClient: async (config) => {
        receivedRange = config.headers.Range;
        receivedIfRange = config.headers['If-Range'];
        return {
          status: 206,
          headers: {
            'content-length': String(payload.length - offset),
            'content-range': `bytes ${offset}-${payload.length - 1}/${payload.length}`,
            'etag': '"asset-v2"',
          },
          data: Readable.from([payload.subarray(offset)]),
        };
      },
    });
    const asset = {
      assetId: '102',
      filename: 'yuyan.exe',
      size: payload.length,
      sha256: digestPayload(payload),
    };
    const { partialPath, cachePath } = manager.getPaths(asset);
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(partialPath, payload.subarray(0, offset));
    await fs.writeFile(`${partialPath}.etag`, '"asset-v1"', 'utf8');

    await manager.ensureCached(asset);
    const completed = await manager.waitForAsset(asset, 5000);
    assert.equal(completed.status, 'ready');
    assert.equal(receivedRange, `bytes=${offset}-`);
    assert.equal(receivedIfRange, '"asset-v1"');
    assert.deepEqual(await fs.readFile(cachePath), payload);
    await assert.rejects(fs.stat(partialPath), { code: 'ENOENT' });
  });
});

test('损坏正式缓存会被删除并重新从 GitHub 预热', async () => {
  await withTempCache(async (cacheDir) => {
    const payload = createExePayload();
    let requestCount = 0;
    const manager = createUpdateAssetCacheManager({
      cacheDir,
      getGithubToken: () => 'test-token',
      downloadClient: async () => {
        requestCount += 1;
        return {
          status: 200,
          headers: { 'content-length': String(payload.length) },
          data: Readable.from([payload]),
        };
      },
    });
    const asset = {
      assetId: '103',
      filename: 'yuyan.exe',
      size: payload.length,
      sha256: digestPayload(payload),
    };
    const { cachePath } = manager.getPaths(asset);
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(cachePath, Buffer.alloc(payload.length));

    await manager.ensureCached(asset);
    const completed = await manager.waitForAsset(asset, 5000);
    assert.equal(completed.status, 'ready');
    assert.equal(requestCount, 1);
    assert.deepEqual(await fs.readFile(cachePath), payload);
  });
});
