/**
 * GitLab 地址白名单（#62）测试：归一化、策略推导、假地址拒绝且不发请求、合法地址放行。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertGitlabHostAllowed,
  isGitlabHostAllowed,
  normalizeGitlabHostValue,
  parseAllowedGitlabHosts,
  resolveGitlabHostPolicy,
  setLearnedGitlabHosts,
} from '../gitlab-host-policy.mjs';
import { verifyGitlabCredential, exchangeGitlabIdentity } from '../central-identity-service.mjs';
import { resetCommitMetaCaches, resolveCommitMeta } from '../commit-meta-service.mjs';
import { validateScaffoldGitlabConfig } from '../scaffold-validation.mjs';

const POLICY_ENV_KEYS = ['YUYAN_ALLOWED_GITLAB_HOSTS', 'GITLAB_HOST', 'VITE_GITLAB_HOST', 'HOST', 'IS_TAURI_SUBPROCESS'];

/**
 * 在临时环境变量与 fetch 桩下执行测试，结束后恢复。
 * @param {Record<string, string|undefined>} env 环境变量
 * @param {(calls: string[]) => Promise<void>|void} fn 测试体
 */
async function withPolicyEnv(env, fn) {
  const saved = Object.fromEntries(POLICY_ENV_KEYS.map((key) => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ id: 7, username: 'alice', name: 'Alice' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  for (const key of POLICY_ENV_KEYS) delete process.env[key];
  Object.entries(env).forEach(([key, value]) => {
    if (value !== undefined) process.env[key] = value;
  });
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of POLICY_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    setLearnedGitlabHosts([]);
  }
}

test('归一化：协议/主机小写、去默认端口、尾斜杠、/api/v4 与账号密码', () => {
  assert.equal(normalizeGitlabHostValue('HTTP://GitLab.Example.com:80/'), 'http://gitlab.example.com');
  assert.equal(normalizeGitlabHostValue('https://gitlab.example.com:443/api/v4/'), 'https://gitlab.example.com');
  assert.equal(normalizeGitlabHostValue('http://u:p@10.0.0.5:8081/?a=1#x'), 'http://10.0.0.5:8081');
  assert.equal(normalizeGitlabHostValue('http://10.0.0.5:8081/gitlab/'), 'http://10.0.0.5:8081/gitlab');
  assert.equal(normalizeGitlabHostValue('ftp://gitlab.example.com'), '');
  assert.equal(normalizeGitlabHostValue('not a url'), '');
  assert.equal(normalizeGitlabHostValue(''), '');
});

test('白名单解析：逗号分隔、未写协议同时允许 http/https、非法条目单独列出、* 表示不限制', () => {
  const parsed = parseAllowedGitlabHosts(' http://a.example.com/ , b.example.com:8443 ,, ftp://bad ,*');
  assert.deepEqual(parsed.hosts.sort(), ['http://a.example.com', 'http://b.example.com:8443', 'https://b.example.com:8443'].sort());
  assert.deepEqual(parsed.invalid, ['ftp://bad']);
  assert.equal(parsed.allowAll, true);
});

test('策略：显式配置优先，忽略 GITLAB_HOST 与已有账号', () => {
  const policy = resolveGitlabHostPolicy({
    env: { YUYAN_ALLOWED_GITLAB_HOSTS: 'http://gitlab.corp', GITLAB_HOST: 'http://other', HOST: '0.0.0.0' },
    learned: ['http://learned'],
  });
  assert.equal(policy.mode, 'explicit');
  assert.deepEqual(policy.hosts, ['http://gitlab.corp']);
});

test('策略：未显式配置时由 GITLAB_HOST、VITE_GITLAB_HOST 与已有账号地址推导', () => {
  const policy = resolveGitlabHostPolicy({
    env: { GITLAB_HOST: 'http://gitlab.corp/', VITE_GITLAB_HOST: 'http://gitlab.corp', HOST: '0.0.0.0' },
    learned: ['http://192.168.1.10:8081'],
  });
  assert.equal(policy.mode, 'derived');
  assert.deepEqual(policy.hosts.sort(), ['http://192.168.1.10:8081', 'http://gitlab.corp'].sort());
  assert.deepEqual(policy.sources.identity_links, ['http://192.168.1.10:8081']);
});

test('策略：推导为空时本机模式不限制，非本机模式拒绝；显式配置全部非法按推不出处理', () => {
  assert.equal(resolveGitlabHostPolicy({ env: {}, learned: [] }).mode, 'open');
  assert.equal(resolveGitlabHostPolicy({ env: { IS_TAURI_SUBPROCESS: 'true', HOST: '0.0.0.0' }, learned: [] }).mode, 'open');
  assert.equal(resolveGitlabHostPolicy({ env: { HOST: '0.0.0.0' }, learned: [] }).mode, 'closed');
  assert.equal(resolveGitlabHostPolicy({ env: { HOST: '0.0.0.0', YUYAN_ALLOWED_GITLAB_HOSTS: 'ftp://x' }, learned: [] }).mode, 'closed');
  assert.equal(isGitlabHostAllowed('http://anything', { env: { HOST: '0.0.0.0' }, learned: [] }), false);
  assert.equal(isGitlabHostAllowed('http://anything', { env: {}, learned: [] }), true);
  assert.equal(isGitlabHostAllowed('http://anything', { env: { HOST: '0.0.0.0', YUYAN_ALLOWED_GITLAB_HOSTS: '*' }, learned: [] }), true);
});

test('校验：白名单内的不同写法都放行，其他地址抛 403 gitlab_host_not_allowed', () => {
  const options = { env: { HOST: '0.0.0.0', YUYAN_ALLOWED_GITLAB_HOSTS: 'gitlab.corp:8081' }, learned: [] };
  assert.equal(assertGitlabHostAllowed('HTTP://gitlab.corp:8081/api/v4/', options), 'http://gitlab.corp:8081');
  assert.equal(assertGitlabHostAllowed('https://gitlab.corp:8081', options), 'https://gitlab.corp:8081');
  assert.throws(() => assertGitlabHostAllowed('http://gitlab.corp:8082', options), (error) => error.status === 403 && error.code === 'gitlab_host_not_allowed');
  assert.throws(() => assertGitlabHostAllowed('http://evil.example', options), (error) => error.status === 403);
  assert.equal(isGitlabHostAllowed('http://gitlab.corp:8081/group/repo.git', { ...options, matchOrigin: true }), true);
  assert.equal(isGitlabHostAllowed('http://evil.example/group/repo.git', { ...options, matchOrigin: true }), false);
});

test('网页端鉴权：假地址直接拒绝且不发出任何请求', async () => {
  await withPolicyEnv({ HOST: '0.0.0.0', YUYAN_ALLOWED_GITLAB_HOSTS: 'http://gitlab.corp' }, async (calls) => {
    await assert.rejects(
      verifyGitlabCredential({ gitlabHost: 'http://127.0.0.1:18081', gitlabToken: 'anything-123' }),
      (error) => error.status === 403 && error.code === 'gitlab_host_not_allowed'
    );
    assert.deepEqual(calls, []);
  });
});

test('网页端鉴权：白名单内地址正常请求 GitLab 并返回用户', async () => {
  await withPolicyEnv({ HOST: '0.0.0.0', YUYAN_ALLOWED_GITLAB_HOSTS: 'http://gitlab.corp' }, async (calls) => {
    const result = await verifyGitlabCredential({ gitlabHost: 'http://gitlab.corp/', gitlabToken: 'anything-123' });
    assert.equal(result.gitlabHost, 'http://gitlab.corp');
    assert.equal(result.user.id, 7);
    assert.deepEqual(calls, ['http://gitlab.corp/api/v4/user']);
  });
});

test('网页端鉴权：非本机模式且白名单推不出时拒绝', async () => {
  await withPolicyEnv({ HOST: '0.0.0.0' }, async (calls) => {
    await assert.rejects(
      verifyGitlabCredential({ gitlabHost: 'http://gitlab.corp', gitlabToken: 'anything-123' }),
      (error) => error.status === 403 && /YUYAN_ALLOWED_GITLAB_HOSTS/.test(error.message)
    );
    assert.deepEqual(calls, []);
  });
});

test('已有账号登录过的地址在未显式配置时被放行', async () => {
  await withPolicyEnv({ HOST: '0.0.0.0' }, async (calls) => {
    setLearnedGitlabHosts(['http://gitlab.corp/']);
    const result = await verifyGitlabCredential({ gitlabHost: 'http://gitlab.corp', gitlabToken: 'anything-123' });
    assert.equal(result.user.id, 7);
    assert.equal(calls.length, 1);
  });
});

test('App 换票：假地址在访问 GitLab 与数据库之前被拒绝', async () => {
  await withPolicyEnv({ HOST: '0.0.0.0', YUYAN_ALLOWED_GITLAB_HOSTS: 'http://gitlab.corp' }, async (calls) => {
    await assert.rejects(
      exchangeGitlabIdentity({
        gitlabHost: 'http://127.0.0.1:18081',
        gitlabToken: 'anything-123',
        device: { deviceId: '2f1b7f4e-8f7a-4d39-9a43-1d6f0f3f1a11', publicKey: 'A'.repeat(44), deviceName: 'poc', platform: 'linux' },
      }),
      (error) => error.status === 403 && error.code === 'gitlab_host_not_allowed'
    );
    assert.deepEqual(calls, []);
  });
});

test('提交信息补全：请求头里的非白名单地址不发请求', async () => {
  await withPolicyEnv({ HOST: '0.0.0.0', YUYAN_ALLOWED_GITLAB_HOSTS: 'http://gitlab.corp' }, async (calls) => {
    resetCommitMetaCaches();
    const meta = await resolveCommitMeta(12, 'abc123', 'token-123', 'http://evil.example');
    assert.deepEqual(meta, { message: '', author: '', transient: false });
    assert.deepEqual(calls, []);
    resetCommitMetaCaches();
  });
});

test('脚手架建仓：非白名单地址校验失败', async () => {
  await withPolicyEnv({ HOST: '0.0.0.0', YUYAN_ALLOWED_GITLAB_HOSTS: 'http://gitlab.corp' }, async () => {
    const base = { createRepo: true, gitlabToken: 'token-123', namespaceId: '5' };
    assert.match(validateScaffoldGitlabConfig({ ...base, gitlabHost: 'http://evil.example' }), /允许的 GitLab 地址/);
    assert.equal(validateScaffoldGitlabConfig({ ...base, gitlabHost: 'http://gitlab.corp' }), '');
  });
});
