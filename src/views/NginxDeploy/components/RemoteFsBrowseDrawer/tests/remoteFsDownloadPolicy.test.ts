import assert from 'node:assert/strict';
import test from 'node:test';
import { getContextMenuItems } from '../components/RemoteFsContextMenu/constant.ts';
import { buildFsSuggestedFileName, parseDownloadFileName } from '../constant.ts';
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

