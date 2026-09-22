import assert from 'node:assert/strict';
import test from 'node:test';
import { isLocalService, isTauri } from '../env.ts';

test('isLocalService: SSR / 纯 Node 环境无 window 时安全回退为 false', () => {
  assert.equal(isLocalService({ customWindow: null }), false);
});

test('isLocalService: 本地开发环境 (isDev = true) 允许展示测试功能', () => {
  const mockWindow = {
    location: { hostname: 'example.com' },
  };
  assert.equal(isLocalService({ isDev: true, customWindow: mockWindow }), true);
});

test('isLocalService: Tauri 生产打包桌面客户端 (正式发布版) 严格禁止展示测试功能', () => {
  const mockWindow = {
    __TAURI_INTERNALS__: {},
    location: { hostname: 'localhost' },
  };
  assert.equal(isLocalService({ isDev: false, customWindow: mockWindow }), false);
});

test('isLocalService: Tauri 桌面端本地开发调试模式下允许展示测试功能', () => {
  const mockWindow = {
    __TAURI_INTERNALS__: {},
    location: { hostname: 'localhost' },
  };
  assert.equal(isLocalService({ isDev: true, customWindow: mockWindow }), true);
});

test('isLocalService: Web 端本地回环服务 (localhost / 127.0.0.1 / ::1) 允许展示测试功能', () => {
  assert.equal(isLocalService({ isDev: false, customWindow: { location: { hostname: 'localhost' } } }), true);
  assert.equal(isLocalService({ isDev: false, customWindow: { location: { hostname: '127.0.0.1' } } }), true);
  assert.equal(isLocalService({ isDev: false, customWindow: { location: { hostname: '::1' } } }), true);
});

test('isLocalService: 线上生产部署站点 (非本地域名与远端 IP) 严格隐藏测试功能', () => {
  assert.equal(isLocalService({ isDev: false, customWindow: { location: { hostname: 'yuyan.ops.company.com' } } }), false);
  assert.equal(isLocalService({ isDev: false, customWindow: { location: { hostname: '10.10.12.34' } } }), false);
  assert.equal(isLocalService({ isDev: false, customWindow: { location: { hostname: '192.168.1.100' } } }), false);
});

test('isLocalService: localStorage 中存在 YUYAN_DEBUG_NOTIFICATION 覆盖标记时允许开启测试功能', () => {
  const mockWindow = {
    localStorage: {
      getItem: (key: string) => (key === 'YUYAN_DEBUG_NOTIFICATION' ? 'true' : null),
    },
    location: { hostname: 'yuyan.ops.company.com' },
  };
  assert.equal(isLocalService({ isDev: false, customWindow: mockWindow }), true);
});
