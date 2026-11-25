import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canRevokeSessionItem,
  formatProfileDate,
  formatProfileDateTime,
  formatSuccessRate,
  mergeGitlabProfile,
  resolveDeployActionLabel,
  resolveDeployStatusMeta,
  resolvePlatformLabel,
  resolveRoleDisplay,
  shortenDeviceId,
} from '../profilePolicy.ts';

test('mergeGitlabProfile: 优先使用后端字段并用前端登录态兜底，缺失字段安全降级', () => {
  const merged = mergeGitlabProfile(
    {
      id: 101,
      host: 'https://gitlab.ysstech.com',
      username: 'wangyancong',
      displayName: '王彦聪',
      avatarUrl: 'https://gitlab.ysstech.com/avatar.png',
      email: '',
      createdAt: '',
      webUrl: '',
    },
    {
      id: 101,
      username: 'wangyancong',
      name: '王彦聪',
      email: 'wangyancong@ysstech.com',
      created_at: '2021-05-12T08:30:00.000Z',
      web_url: 'https://gitlab.ysstech.com/wangyancong',
    },
  );
  assert.equal(merged.email, 'wangyancong@ysstech.com');
  assert.equal(merged.createdAt, '2021-05-12T08:30:00.000Z');
  assert.equal(merged.webUrl, 'https://gitlab.ysstech.com/wangyancong');

  const empty = mergeGitlabProfile(null, null, 'https://gitlab.example.com');
  assert.equal(empty.displayName, 'GitLab 用户');
  assert.equal(empty.email, '');
  assert.equal(empty.createdAt, '');
  assert.equal(empty.webUrl, '');
  assert.equal(empty.host, 'https://gitlab.example.com');
});

test('formatProfileDate & formatProfileDateTime: 正常格式化并优雅处理空值与非法值', () => {
  assert.equal(formatProfileDate(''), '未知');
  assert.equal(formatProfileDate('not-a-date'), '未知');
  assert.match(formatProfileDate('2021-05-12T08:30:00.000Z'), /^\d{4}-\d{2}-\d{2}$/);

  assert.equal(formatProfileDateTime(null), '时间未知');
  assert.equal(formatProfileDateTime('bad'), '时间未知');
  assert.match(formatProfileDateTime('2026-11-25T09:15:00.000Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('resolveRoleDisplay & resolvePlatformLabel: 正确映射角色权限与设备平台', () => {
  assert.equal(resolveRoleDisplay('admin').shortLabel, 'admin');
  assert.equal(resolveRoleDisplay('operator').shortLabel, 'operator');
  assert.equal(resolveRoleDisplay('viewer').shortLabel, 'viewer');
  assert.equal(resolveRoleDisplay('').shortLabel, 'web');

  assert.equal(resolvePlatformLabel('macos'), 'macOS');
  assert.equal(resolvePlatformLabel('windows'), 'Windows');
  assert.equal(resolvePlatformLabel('linux'), 'Linux');
  assert.equal(resolvePlatformLabel(''), '未知平台');
});

test('canRevokeSessionItem: 当前会话或非活跃会话禁止注销，其他活跃会话允许注销', () => {
  assert.equal(canRevokeSessionItem({ isCurrent: true, status: 'active' }), false);
  assert.equal(canRevokeSessionItem({ isCurrent: false, status: 'revoked' }), false);
  assert.equal(canRevokeSessionItem({ isCurrent: false, status: 'active' }), true);
  assert.equal(canRevokeSessionItem(null), false);
});

test('formatSuccessRate, resolveDeployStatusMeta, resolveDeployActionLabel, shortenDeviceId', () => {
  assert.equal(formatSuccessRate({ finishedCount: 0, successRate: null }), '--');
  assert.equal(formatSuccessRate({ finishedCount: 10, successRate: 80 }), '80%');
  assert.equal(formatSuccessRate({ finishedCount: 13, successRate: 92.3 }), '92.3%');

  assert.deepEqual(resolveDeployStatusMeta('success'), { label: '成功', color: 'success' });
  assert.deepEqual(resolveDeployStatusMeta('failed'), { label: '失败', color: 'error' });
  assert.deepEqual(resolveDeployStatusMeta('stopped'), { label: '已停止', color: 'default' });
  assert.deepEqual(resolveDeployStatusMeta('running'), { label: '进行中', color: 'processing' });

  assert.equal(resolveDeployActionLabel('deploy'), '发布');
  assert.equal(resolveDeployActionLabel('rollback'), '回滚');
  assert.equal(resolveDeployActionLabel('undoRollback'), '撤销回滚');

  assert.equal(shortenDeviceId('11111111-2222-3333-4444-555555555555'), '11111111...5555');
  assert.equal(shortenDeviceId('short-id'), 'short-id');
});
