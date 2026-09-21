import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEPLOY_NOTIFICATION_STORAGE_KEY,
  clearDeployNotificationHistory,
  formatDeployNotificationContent,
  isDeployNotificationEnabled,
  notifyDeployResult,
  setDeployNotificationEnabled,
} from '../deployNotification.ts';

// 简易 LocalStorage 模拟环境
const createMockLocalStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  };
};

test('formatDeployNotificationContent: 成功状态文案格式化规范', () => {
  // 1. 完整指定 targetName 与 envName
  const res1 = formatDeployNotificationContent({
    status: 'success',
    projectName: 'yuyan-portal',
    targetName: '测试服务器01',
    envName: '测试环境',
  });
  assert.equal(res1.title, '部署成功');
  assert.equal(res1.body, 'yuyan-portal 已成功发布到「测试服务器01」');

  // 2. 缺少 targetName 时回退到 envName
  const res2 = formatDeployNotificationContent({
    status: 'success',
    projectName: 'yuyan-app',
    envName: '生产环境',
  });
  assert.equal(res2.title, '部署成功');
  assert.equal(res2.body, 'yuyan-app 已成功发布到「生产环境」');

  // 3. 两个名称均缺少时优雅回退「服务器」
  const res3 = formatDeployNotificationContent({
    status: 'success',
    projectName: '',
  });
  assert.equal(res3.title, '部署成功');
  assert.equal(res3.body, '项目 已成功发布到「服务器」');
});

test('formatDeployNotificationContent: 失败状态文案格式化规范', () => {
  // 1. 包含阶段与错误摘要
  const res1 = formatDeployNotificationContent({
    status: 'error',
    projectName: 'yuyan-admin',
    stage: '依赖安装',
    errorMessage: 'npm ERR! code ERESOLVE',
  });
  assert.equal(res1.title, '部署失败');
  assert.equal(res1.body, 'yuyan-admin 在「依赖安装」执行失败：npm ERR! code ERESOLVE');

  // 2. 不包含阶段时简洁展示错误
  const res2 = formatDeployNotificationContent({
    status: 'error',
    projectName: 'yuyan-admin',
    errorMessage: 'SSH 认证超时',
  });
  assert.equal(res2.title, '部署失败');
  assert.equal(res2.body, 'yuyan-admin 执行失败：SSH 认证超时');

  // 3. 错误原因缺省时回退「未知异常」
  const res3 = formatDeployNotificationContent({
    status: 'error',
    projectName: 'yuyan-admin',
  });
  assert.equal(res3.title, '部署失败');
  assert.equal(res3.body, 'yuyan-admin 执行失败：未知异常');
});

test('用户偏好设置: 默认开启，支持持久化开关切换', () => {
  const originalWindow = globalThis.window;
  const mockStorage = createMockLocalStorage();
  (globalThis as any).window = { localStorage: mockStorage };

  try {
    // 首次读取默认为 true
    assert.equal(isDeployNotificationEnabled(), true);

    // 设置为 false
    setDeployNotificationEnabled(false);
    assert.equal(isDeployNotificationEnabled(), false);
    assert.equal(mockStorage.getItem(DEPLOY_NOTIFICATION_STORAGE_KEY), 'false');

    // 重新开启
    setDeployNotificationEnabled(true);
    assert.equal(isDeployNotificationEnabled(), true);
    assert.equal(mockStorage.getItem(DEPLOY_NOTIFICATION_STORAGE_KEY), 'true');
  } finally {
    (globalThis as any).window = originalWindow;
  }
});

test('notifyDeployResult: 防重幂等策略保证同一任务只提醒一次', async () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;

  const sentNotifications: Array<{ title: string; options?: any }> = [];

  class MockNotification {
    static permission = 'granted';
    constructor(title: string, options?: any) {
      sentNotifications.push({ title, options });
    }
  }

  const mockStorage = createMockLocalStorage();
  (globalThis as any).window = {
    localStorage: mockStorage,
    Notification: MockNotification,
  };
  (globalThis as any).document = {
    hasFocus: () => false, // 模拟失焦状态
    visibilityState: 'hidden',
  };

  clearDeployNotificationHistory();

  try {
    const taskDeployId = 'deploy-session-20260921-001';

    // 第一次触发终态通知 -> 成功发出
    const firstResult = await notifyDeployResult({
      status: 'success',
      projectName: 'yuyan-core',
      targetName: '生产主机 A',
      deployId: taskDeployId,
    });
    assert.equal(firstResult, true);
    assert.equal(sentNotifications.length, 1);
    assert.equal(sentNotifications[0].title, '部署成功');

    // 同一 deployId 再次触发 -> 幂等防重，返回 false 且不重复发送
    const secondResult = await notifyDeployResult({
      status: 'success',
      projectName: 'yuyan-core',
      targetName: '生产主机 A',
      deployId: taskDeployId,
    });
    assert.equal(secondResult, false);
    assert.equal(sentNotifications.length, 1);

    // 清理防重缓存后，允许再次发送
    clearDeployNotificationHistory();
    const thirdResult = await notifyDeployResult({
      status: 'success',
      projectName: 'yuyan-core',
      targetName: '生产主机 A',
      deployId: taskDeployId,
    });
    assert.equal(thirdResult, true);
    assert.equal(sentNotifications.length, 2);
  } finally {
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
  }
});

test('notifyDeployResult: 窗口前台且聚焦时默认静默，不发系统通知', async () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;

  const sentNotifications: any[] = [];
  class MockNotification {
    static permission = 'granted';
    constructor(title: string, options?: any) {
      sentNotifications.push({ title, options });
    }
  }

  const mockStorage = createMockLocalStorage();
  (globalThis as any).window = {
    localStorage: mockStorage,
    Notification: MockNotification,
  };
  (globalThis as any).document = {
    hasFocus: () => true, // 聚焦前台
    visibilityState: 'visible',
  };

  clearDeployNotificationHistory();

  try {
    // 聚焦前台不加 force -> 不弹系统通知
    const result = await notifyDeployResult({
      status: 'success',
      projectName: 'yuyan-core',
      deployId: 'focus-test-1',
    });
    assert.equal(result, false);
    assert.equal(sentNotifications.length, 0);

    // 传入 force: true -> 忽略聚焦判定强发
    const forcedResult = await notifyDeployResult({
      status: 'success',
      projectName: 'yuyan-core',
      deployId: 'focus-test-2',
      force: true,
    });
    assert.equal(forcedResult, true);
    assert.equal(sentNotifications.length, 1);
  } finally {
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
  }
});

test('notifyDeployResult: 用户开关关闭时直接跳过系统通知', async () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;

  const sentNotifications: any[] = [];
  class MockNotification {
    static permission = 'granted';
    constructor(title: string, options?: any) {
      sentNotifications.push({ title, options });
    }
  }

  const mockStorage = createMockLocalStorage();
  mockStorage.setItem(DEPLOY_NOTIFICATION_STORAGE_KEY, 'false'); // 用户关闭了开关

  (globalThis as any).window = {
    localStorage: mockStorage,
    Notification: MockNotification,
  };
  (globalThis as any).document = {
    hasFocus: () => false,
    visibilityState: 'hidden',
  };

  try {
    const result = await notifyDeployResult({
      status: 'success',
      projectName: 'yuyan-core',
      deployId: 'disabled-test',
      force: true,
    });
    assert.equal(result, false);
    assert.equal(sentNotifications.length, 0);
  } finally {
    (globalThis as any).window = originalWindow;
    (globalThis as any).document = originalDocument;
  }
});
