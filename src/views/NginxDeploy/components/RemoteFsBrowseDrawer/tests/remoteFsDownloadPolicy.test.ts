import assert from 'node:assert/strict';
import test from 'node:test';
import { getContextMenuItems } from '../components/RemoteFsContextMenu/constant.ts';
import { buildFsSuggestedFileName } from '../constant.ts';
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
