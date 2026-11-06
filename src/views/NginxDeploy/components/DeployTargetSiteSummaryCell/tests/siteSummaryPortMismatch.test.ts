import assert from 'node:assert/strict';
import test from 'node:test';
import type { DeployTarget } from '@/api/deploy';
import { getSiteReadinessStatus } from '../constant.ts';

/** 构造最小可用的已有实例前端目标 */
const createTarget = (overrides: Partial<DeployTarget> = {}) => ({
  id: 1,
  projectType: 'frontend',
  nginxInstanceId: 3,
  nginxInstanceName: '已有 Nginx',
  nginxInstanceType: 'external',
  nginxSiteManaged: false,
  nginxServerName: '_',
  deployRoot: '/data/www/app',
  listenPort: 9999,
  visitUrl: 'http://192.168.165.60:8050',
  ...overrides,
}) as unknown as DeployTarget;

test('访问地址端口和监听端口不一致时带提示，端口展示仍来自监听端口', () => {
  const meta = getSiteReadinessStatus(createTarget());
  assert.equal(meta.listenPort, 9999);
  assert.equal(meta.destinationText, '/data/www/app:9999');
  assert.ok(meta.portMismatchHint.startsWith('访问地址端口为 8050，监听端口为 9999'));
  assert.equal(meta.visitUrl, 'http://192.168.165.60:8050');
});

test('一致时不带提示', () => {
  const meta = getSiteReadinessStatus(createTarget({ listenPort: 8050 }));
  assert.equal(meta.portMismatchHint, '');
  assert.equal(meta.destinationText, '/data/www/app:8050');
});

test('https 默认端口与监听端口一致时不带提示', () => {
  assert.equal(getSiteReadinessStatus(createTarget({ listenPort: 443, visitUrl: 'https://yuyan.example.com/app' })).portMismatchHint, '');
});

test('未记录监听端口、访问地址为空或无法解析时不带提示', () => {
  assert.equal(getSiteReadinessStatus(createTarget({ listenPort: 0 })).portMismatchHint, '');
  assert.equal(getSiteReadinessStatus(createTarget({ visitUrl: '' })).portMismatchHint, '');
  assert.equal(getSiteReadinessStatus(createTarget({ visitUrl: '未配置' })).portMismatchHint, '');
});

test('未关联实例或空目标不带提示', () => {
  assert.equal(getSiteReadinessStatus(createTarget({ nginxInstanceId: 0 })).portMismatchHint, '');
  assert.equal(getSiteReadinessStatus(null).portMismatchHint, '');
});
