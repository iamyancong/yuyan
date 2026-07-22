import assert from 'node:assert/strict';
import test from 'node:test';
import { validateScaffoldGitlabConfig } from '../scaffold-validation.mjs';

test('本地下载模式不要求 GitLab 配置', () => {
  assert.equal(validateScaffoldGitlabConfig({ createRepo: false }), '');
});

test('创建 GitLab 仓库时必须显式选择 Namespace', () => {
  const error = validateScaffoldGitlabConfig({
    createRepo: true,
    gitlabHost: 'http://gitlab.example.com',
    gitlabToken: 'token-value',
    namespaceId: '',
  });

  assert.match(error, /必须选择 Namespace/);
});

test('创建 GitLab 仓库时拒绝非法 Host 和 Namespace ID', () => {
  assert.match(
    validateScaffoldGitlabConfig({ createRepo: true, gitlabHost: 'gitlab.local', gitlabToken: 'token-value', namespaceId: '1393' }),
    /格式无效/,
  );
  assert.match(
    validateScaffoldGitlabConfig({
      createRepo: true,
      gitlabHost: 'https://gitlab.example.com',
      gitlabToken: 'token-value',
      namespaceId: 'group/path',
    }),
    /有效的 GitLab Group ID/,
  );
});

test('完整 GitLab 创建配置校验通过', () => {
  assert.equal(
    validateScaffoldGitlabConfig({
      createRepo: true,
      gitlabHost: 'https://gitlab.example.com/',
      gitlabToken: 'token-value',
      namespaceId: '1393',
    }),
    '',
  );
});
