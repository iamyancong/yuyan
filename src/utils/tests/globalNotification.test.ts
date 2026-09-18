import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_NOTIFICATION_DURATIONS,
  resolveNotificationDuration,
  type GlassNotificationType,
} from '../globalNotification.ts';

test('resolveNotificationDuration: 未显式指定时长时赋予各类型合理时长且杜绝意外常驻', () => {
  assert.equal(resolveNotificationDuration('success'), 3.5);
  assert.equal(resolveNotificationDuration('info'), 3.5);
  assert.equal(resolveNotificationDuration('warning'), 4.0);
  assert.equal(resolveNotificationDuration('error'), 5.0);
  assert.equal(resolveNotificationDuration('loading'), 0);
  assert.equal(resolveNotificationDuration('unknown' as GlassNotificationType), 3.5);
});

test('resolveNotificationDuration: 显式传入合法正数或0时优先使用显式时长', () => {
  assert.equal(resolveNotificationDuration('success', 2.0), 2.0);
  assert.equal(resolveNotificationDuration('success', 0), 0);
  assert.equal(resolveNotificationDuration('error', 8.0), 8.0);
  // 传入负数或非法值时优雅回退默认
  assert.equal(resolveNotificationDuration('success', -1), 3.5);
  assert.equal(resolveNotificationDuration('error', undefined), 5.0);
});

test('DEFAULT_NOTIFICATION_DURATIONS 配置表包含全量通知状态规范', () => {
  assert.ok(DEFAULT_NOTIFICATION_DURATIONS.success <= 4.0, '成功通知不宜过长，保证迅速反馈');
  assert.ok(DEFAULT_NOTIFICATION_DURATIONS.error >= 4.5, '错误通知需留足阅读时间');
  assert.equal(DEFAULT_NOTIFICATION_DURATIONS.loading, 0, '加载状态应由任务完成主动关闭');
});
