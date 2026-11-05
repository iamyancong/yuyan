import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveNginxVersionDisplay } from '../utils/versionDisplay.ts';

test('版本一致时展示单一版本', () => {
  const d = resolveNginxVersionDisplay({ version: 'nginx/1.24.0', runningVersion: 'nginx/1.24.0', diskVersion: 'nginx/1.24.0' });
  assert.equal(d.label, 'nginx/1.24.0');
  assert.equal(d.upgradePending, false);
});

test('运行与磁盘不一致时提示待平滑升级', () => {
  const d = resolveNginxVersionDisplay({ runningVersion: 'nginx/1.24.0', diskVersion: 'nginx/1.25.0', upgradePending: true });
  assert.match(d.label, /待平滑升级/);
  assert.equal(d.upgradePending, true);
});

test('探测失败时展示未知与 tooltip 原因', () => {
  const d = resolveNginxVersionDisplay({ versionDetectError: '无法从校验命令安全提取' });
  assert.equal(d.label, '未知');
  assert.match(d.tooltip, /无法从校验命令安全提取/);
});
