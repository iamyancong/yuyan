import assert from 'node:assert/strict';
import test from 'node:test';

// 准备测试环境的浏览器 window / storage mock
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

const mockSessionStorage = new MemoryStorage();
const mockLocalStorage = new MemoryStorage();

(globalThis as any).window = {
  sessionStorage: mockSessionStorage,
  localStorage: mockLocalStorage,
};

// 动态引入被测模块
const {
  saveSecureAccount,
  loadActiveSecureAccount,
  clearActiveSecureAccount,
  getRememberLoginPreference,
  WEB_ACCOUNT_SESSION_KEY,
  WEB_ACCOUNT_LOCAL_KEY,
  WEB_REMEMBER_TTL_MS,
} = await import('../secureAuth.ts');

const mockAccount = {
  accountId: 'web:https://gitlab.example.com:101',
  deviceId: '',
  gitlabHost: 'https://gitlab.example.com',
  gitlabUserId: 101,
  gitlabUsername: 'tester',
  gitlabDisplayName: '测试用户',
  gitlabAvatarUrl: 'https://gitlab.example.com/avatar.png',
  gitlabToken: 'glpat-dummy-token-123456',
  accessToken: '',
  refreshToken: '',
  teamId: '',
  role: '' as const,
  accessExpiresAt: '',
  refreshExpiresAt: '',
};

test('未设置偏好时，记住我默认处于选中状态 (true)', () => {
  mockLocalStorage.clear();
  assert.equal(getRememberLoginPreference(), true);
});

test('未勾选记住我时，仅存入 sessionStorage，不写入 localStorage', async () => {
  mockSessionStorage.clear();
  mockLocalStorage.clear();

  await saveSecureAccount(mockAccount as any, false);

  assert.ok(mockSessionStorage.getItem(WEB_ACCOUNT_SESSION_KEY));
  assert.equal(mockLocalStorage.getItem(WEB_ACCOUNT_LOCAL_KEY), null);
  assert.equal(getRememberLoginPreference(), false);

  const loaded = await loadActiveSecureAccount(true);
  assert.equal(loaded?.gitlabUsername, 'tester');
});

test('勾选记住我时，同时写入 sessionStorage 与 localStorage，并设置 30 天有效期', async () => {
  mockSessionStorage.clear();
  mockLocalStorage.clear();

  const beforeTime = Date.now();
  await saveSecureAccount(mockAccount as any, true);

  const localRaw = mockLocalStorage.getItem(WEB_ACCOUNT_LOCAL_KEY);
  assert.ok(localRaw);
  const parsed = JSON.parse(localRaw!);
  assert.equal(parsed.gitlabUsername, 'tester');
  assert.ok(parsed.rememberExpiresAt >= beforeTime + WEB_REMEMBER_TTL_MS - 5000);
  assert.equal(getRememberLoginPreference(), true);

  // 模拟用户关闭标签页：清空 sessionStorage
  mockSessionStorage.clear();

  // 重新打开标签页读取凭据
  const recovered = await loadActiveSecureAccount(true);
  assert.ok(recovered);
  assert.equal(recovered?.gitlabUsername, 'tester');

  // 确认已同步回当前标签页 sessionStorage
  assert.ok(mockSessionStorage.getItem(WEB_ACCOUNT_SESSION_KEY));
});

test('localStorage 中过期的记住我凭据会被自动清除并不再恢复', async () => {
  mockSessionStorage.clear();
  mockLocalStorage.clear();

  const expiredAccount = {
    ...mockAccount,
    rememberExpiresAt: Date.now() - 1000, // 已经过期
  };
  mockLocalStorage.setItem(WEB_ACCOUNT_LOCAL_KEY, JSON.stringify(expiredAccount));

  const loaded = await loadActiveSecureAccount(true);
  assert.equal(loaded, null);
  assert.equal(mockLocalStorage.getItem(WEB_ACCOUNT_LOCAL_KEY), null);
});

test('退出登录时，彻底清除 sessionStorage 与 localStorage', async () => {
  mockSessionStorage.clear();
  mockLocalStorage.clear();

  await saveSecureAccount(mockAccount as any, true);
  assert.ok(mockSessionStorage.getItem(WEB_ACCOUNT_SESSION_KEY));
  assert.ok(mockLocalStorage.getItem(WEB_ACCOUNT_LOCAL_KEY));

  await clearActiveSecureAccount();

  assert.equal(mockSessionStorage.getItem(WEB_ACCOUNT_SESSION_KEY), null);
  assert.equal(mockLocalStorage.getItem(WEB_ACCOUNT_LOCAL_KEY), null);
  assert.equal(await loadActiveSecureAccount(true), null);
});
