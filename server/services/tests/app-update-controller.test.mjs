import test from 'node:test';
import assert from 'node:assert/strict';
import { handleDownloadAppUpdateAsset } from '../../controllers/deploy-controller.mjs';
import { updateAssetCacheManager } from '../app-update-cache-service.mjs';

/** 测试用更新资源。 */
const TEST_ASSET = {
  assetId: '201',
  filename: 'yuyan.exe',
  size: 1024 * 1024 + 32,
  sha256: '',
  etag: '"asset-v1"',
};

/** 创建最小 Express Response 替身。 */
function createResponse() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    file: null,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    sendFile(filePath, options) {
      this.file = { filePath, options };
      return this;
    },
  };
}

/** 临时替换缓存管理器方法并在测试后恢复。 */
async function withCacheManagerStubs(stubs, run) {
  const originals = {};
  for (const [name, implementation] of Object.entries(stubs)) {
    originals[name] = updateAssetCacheManager[name];
    updateAssetCacheManager[name] = implementation;
  }
  try {
    await run();
  } finally {
    for (const [name, implementation] of Object.entries(originals)) {
      updateAssetCacheManager[name] = implementation;
    }
  }
}

test('缓存感知客户端在服务端准备中收到 202 与状态地址', async () => {
  await withCacheManagerStubs({
    resolveAsset: () => TEST_ASSET,
    ensureCached: async () => ({
      status: 'preparing',
      progress: 42,
      downloadedBytes: 420,
      totalBytes: 1000,
      bytesPerSecond: 100,
      remainingSeconds: 6,
      retryCount: 0,
      error: null,
      etag: '',
    }),
  }, async () => {
    const response = createResponse();
    await handleDownloadAppUpdateAsset({
      query: { assetId: TEST_ASSET.assetId, filename: TEST_ASSET.filename, cacheAware: '1' },
      headers: {},
    }, response);

    assert.equal(response.statusCode, 202);
    assert.equal(response.headers['retry-after'], '2');
    assert.equal(response.body.status, 'preparing');
    assert.match(response.body.statusUrl, /app-update\/cache-status/);
  });
});

test('缓存就绪后下载接口直接发送支持 Range 的内网文件', async () => {
  await withCacheManagerStubs({
    resolveAsset: () => TEST_ASSET,
    ensureCached: async () => ({
      status: 'ready',
      downloadedBytes: TEST_ASSET.size,
      totalBytes: TEST_ASSET.size,
      etag: TEST_ASSET.etag,
    }),
    getPaths: () => ({ cachePath: '/tmp/201-yuyan.exe' }),
  }, async () => {
    const response = createResponse();
    await handleDownloadAppUpdateAsset({
      query: { assetId: TEST_ASSET.assetId, filename: TEST_ASSET.filename, cacheAware: '1' },
      headers: {},
    }, response);

    assert.equal(response.headers['x-update-source'], 'cache');
    assert.equal(response.headers['accept-ranges'], 'bytes');
    assert.equal(response.file.filePath, '/tmp/201-yuyan.exe');
    assert.equal(response.file.options.acceptRanges, true);
  });
});
