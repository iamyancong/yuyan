import assert from 'node:assert/strict';
import test from 'node:test';
import { getContextMenuItems, getBatchContextMenuItems } from '../components/RemoteFsContextMenu/constant.ts';
import {
  buildFsSuggestedFileName,
  buildBatchFsSuggestedFileName,
  calculateRangeSelection,
  isDownloadCanceledError,
  parseDownloadFileName,
} from '../constant.ts';
import type { DeployServer, RemoteFsEntry } from '../../../../../api/deploy.ts';

test('getContextMenuItems: 根据条目类型返回正确的右键菜单项', () => {
  assert.deepEqual(getContextMenuItems(null), []);

  const parentDirEntry: RemoteFsEntry = {
    name: '..',
    path: '/opt/yuyan',
    type: 'parent_dir',
    size: null,
    mtime: null,
    permissions: undefined,
  };
  const parentItems = getContextMenuItems(parentDirEntry);
  assert.equal(parentItems.length, 1);
  assert.equal(parentItems[0].key, 'navigateUp');

  const dirEntry: RemoteFsEntry = {
    name: 'assets',
    path: '/opt/yuyan/html/assets',
    type: 'directory',
    size: null,
    mtime: 1700000000,
    permissions: 'rwxr-xr-x',
  };
  const dirItems = getContextMenuItems(dirEntry);
  assert.deepEqual(dirItems.map((item) => item.key), ['download', 'drillDown', 'copyPath']);
  assert.equal(dirItems[0].label, '打包下载到本地');

  const fileEntry: RemoteFsEntry = {
    name: 'index.html',
    path: '/opt/yuyan/html/index.html',
    type: 'file',
    size: 419,
    mtime: 1700000000,
    permissions: 'rw-r--r--',
  };
  const fileItems = getContextMenuItems(fileEntry);
  assert.deepEqual(fileItems.map((item) => item.key), ['download', 'preview', 'copyPath']);
  assert.equal(fileItems[0].label, '下载到本地');
});

test('buildFsSuggestedFileName: 正确推导下载文件名', () => {
  const fakeServer = {
    name: '华贵委外 192.168.100.113',
    host: '192.168.100.113',
  } as DeployServer;

  const dirEntry: RemoteFsEntry = {
    name: 'taskFlow',
    path: '/opt/yuyan/html/taskFlow',
    type: 'directory',
    size: null,
    mtime: null,
    permissions: undefined,
  };
  const dirFileName = buildFsSuggestedFileName(fakeServer, dirEntry);
  assert.match(dirFileName, /^华贵委外-192.168.100.113-taskFlow-\d{14}\.tar\.gz$/);

  const fileEntry: RemoteFsEntry = {
    name: 'nginx.conf',
    path: '/etc/nginx/nginx.conf',
    type: 'file',
    size: 1024,
    mtime: null,
    permissions: undefined,
  };
  const fileName = buildFsSuggestedFileName(fakeServer, fileEntry);
  assert.equal(fileName, 'nginx.conf');
});

test('parseDownloadFileName: 优先遵循 RFC 5987 / RFC 6266 解析 filename*=UTF-8 并解码中文', () => {
  const chineseHeader =
    "attachment; filename=\"________-192.168.165.13-dmDataService-20260924151700.tar.gz\"; filename*=UTF-8''%E5%9B%BD%E5%AF%BF%E6%B5%B7%E5%A4%96%E6%98%9F%E6%B2%B3%E7%B3%BB%E7%BB%9F-192.168.165.13-dmDataService-20260924151700.tar.gz";
  const result = parseDownloadFileName(chineseHeader, 'fallback.tar.gz');
  assert.equal(result, '国寿海外星河系统-192.168.165.13-dmDataService-20260924151700.tar.gz');

  const plainHeader = 'attachment; filename="archive.tar.gz"';
  assert.equal(parseDownloadFileName(plainHeader, 'fallback.tar.gz'), 'archive.tar.gz');

  assert.equal(parseDownloadFileName(null, 'fallback.tar.gz'), 'fallback.tar.gz');
  assert.equal(parseDownloadFileName('', 'fallback.tar.gz'), 'fallback.tar.gz');
});

test('isDownloadCanceledError: 精准识别主动取消异常、门闩标志与正常报错', () => {
  // 门闩状态已取消
  assert.equal(isDownloadCanceledError(new Error('something else'), true), true);
  assert.equal(isDownloadCanceledError(null, true), true);

  // 标准 AbortError 异常
  const abortError = new DOMException('The user aborted a request.', 'AbortError');
  assert.equal(isDownloadCanceledError(abortError), true);
  assert.equal(isDownloadCanceledError({ name: 'AbortError', message: 'aborted' }), true);

  // 包含中文取消文案的错误
  assert.equal(isDownloadCanceledError('用户操作：下载已取消'), true);
  assert.equal(isDownloadCanceledError(new Error('操作中断：导出已取消')), true);

  // 包含 ECONNABORTED 或 connection aborted 等服务端网络中断异常绝不误判为用户主动取消
  assert.equal(isDownloadCanceledError(new Error('connect ECONNABORTED 127.0.0.1:8080')), false);
  assert.equal(isDownloadCanceledError('Error: read connection aborted by peer'), false);
  assert.equal(isDownloadCanceledError(new Error('signal is aborted without reason')), false);
  assert.equal(isDownloadCanceledError('FetchError: request was aborted'), false);

  // 真实网络或业务异常不应被误判为取消
  assert.equal(isDownloadCanceledError(new Error('Failed to fetch: 504 Gateway Timeout')), false);
  assert.equal(isDownloadCanceledError(new Error('服务器返回了空数据，下载未保存')), false);
  assert.equal(isDownloadCanceledError(null), false);
  assert.equal(isDownloadCanceledError(undefined), false);
});


test('getBatchContextMenuItems: 能够生成规范的批量操作菜单项', () => {
  assert.deepEqual(getBatchContextMenuItems([]), []);

  const entries: RemoteFsEntry[] = [
    { name: 'app.js', path: '/var/www/app.js', type: 'file', size: 100, mtime: 123 },
    { name: 'assets', path: '/var/www/assets', type: 'directory', size: null, mtime: 123 },
    { name: 'index.html', path: '/var/www/index.html', type: 'file', size: 200, mtime: 123 },
  ];
  const items = getBatchContextMenuItems(entries);
  assert.equal(items.length, 2);
  assert.equal(items[0].key, 'download');
  assert.equal(items[0].label, '打包下载到本地 (3 项)');
  assert.equal(items[1].key, 'copyPath');
  assert.equal(items[1].label, '复制所有选中路径 (3 项)');
});

test('buildBatchFsSuggestedFileName: 能够生成包含项数与时间戳的批量压缩包文件名', () => {
  const fakeServer = {
    name: '生产主网关 10.0.0.1',
    host: '10.0.0.1',
  } as DeployServer;

  const entries = [
    { name: 'dist', type: 'directory' },
    { name: 'index.html', type: 'file' },
    { name: 'favicon.ico', type: 'file' },
  ];
  const fileName = buildBatchFsSuggestedFileName(fakeServer, entries);
  assert.match(fileName, /^生产主网关-10.0.0.1-batch-3items-\d{14}\.tar\.gz$/);

  const fallbackFileName = buildBatchFsSuggestedFileName(null, []);
  assert.match(fallbackFileName, /^server-batch-\d{14}\.tar\.gz$/);
});

test('calculateRangeSelection: 能够正确切片并强制排除 parent_dir (..)', () => {
  const list = [
    { name: '..', type: 'parent_dir', path: '/var' },
    { name: 'a.txt', type: 'file', path: '/var/a.txt' },
    { name: 'b.txt', type: 'file', path: '/var/b.txt' },
    { name: 'c.txt', type: 'file', path: '/var/c.txt' },
    { name: 'dir1', type: 'directory', path: '/var/dir1' },
  ];

  // 1. 从 0 到 3：索引包含 0 (..)，必须被过滤掉
  const res1 = calculateRangeSelection(list, 0, 3);
  assert.deepEqual(res1.map((i) => i.name), ['a.txt', 'b.txt', 'c.txt']);

  // 2. 从 3 到 1（反向点击，Anchor 在后）
  const res2 = calculateRangeSelection(list, 3, 1);
  assert.deepEqual(res2.map((i) => i.name), ['a.txt', 'b.txt', 'c.txt']);

  // 3. 单行选择（Anchor 等于 target）
  const res3 = calculateRangeSelection(list, 4, 4);
  assert.deepEqual(res3.map((i) => i.name), ['dir1']);

  // 4. 空数组边界
  assert.deepEqual(calculateRangeSelection([], 0, 2), []);
});

