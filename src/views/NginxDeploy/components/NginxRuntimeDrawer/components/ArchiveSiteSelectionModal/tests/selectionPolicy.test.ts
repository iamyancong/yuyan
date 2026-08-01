import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canSubmitArchiveSelection,
  getSelectableArchiveSites,
  normalizeArchiveSiteIds,
} from '../selectionPolicy.ts';

const sites = [
  { id: 'static-site', canDownloadFiles: true },
  { id: 'proxy-only', canDownloadFiles: false },
];

test('默认未选择 server 时下载不可提交', () => {
  assert.equal(canSubmitArchiveSelection([], false, false), false);
});

test('无 root 的 server 只允许配置下载', () => {
  assert.deepEqual(getSelectableArchiveSites(sites, 'all').map((site) => site.id), ['static-site']);
  assert.deepEqual(getSelectableArchiveSites(sites, 'html').map((site) => site.id), ['static-site']);
  assert.deepEqual(getSelectableArchiveSites(sites, 'conf').map((site) => site.id), ['static-site', 'proxy-only']);
});

test('从配置切换到运行包时自动移除无 root 选择', () => {
  assert.deepEqual(normalizeArchiveSiteIds(['static-site', 'proxy-only'], sites, 'all'), ['static-site']);
  assert.equal(canSubmitArchiveSelection(['static-site'], false, false), true);
  assert.equal(canSubmitArchiveSelection(['static-site'], true, false), false);
});
