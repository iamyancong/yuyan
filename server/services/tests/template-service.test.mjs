import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldAttachGitLabToken, buildAuthenticatedRepoUrl } from '../template-service.mjs';

test('shouldAttachGitLabToken: GitHub / 公开开源托管平台严禁注入 GitLab Token', () => {
  assert.equal(
    shouldAttachGitLabToken('https://github.com/iamyancong/microapp-template-vue3.git', 'http://192.168.167.142:8081'),
    false,
  );
  assert.equal(
    shouldAttachGitLabToken('https://github.com/user/repo.git', 'https://gitlab.com'),
    false,
  );
  assert.equal(
    shouldAttachGitLabToken('https://gitee.com/user/repo.git', 'http://10.0.0.1:8080'),
    false,
  );
  assert.equal(
    shouldAttachGitLabToken('https://gitlab.com/group/repo.git', 'http://192.168.1.100'),
    false,
  );
});

test('shouldAttachGitLabToken: 匹配私有 GitLab 实例域名或局域网 IP 时正常注入', () => {
  // 匹配传入的 gitlabHost 域名
  assert.equal(
    shouldAttachGitLabToken('http://gitlab.company.local/frontend/template.git', 'http://gitlab.company.local:8080'),
    true,
  );
  // 内网 IP (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
  assert.equal(
    shouldAttachGitLabToken('http://192.168.167.142:8081/Data-Middleground-Develop-Area/template.git', ''),
    true,
  );
  assert.equal(
    shouldAttachGitLabToken('http://10.10.20.30:10080/group/template.git', ''),
    true,
  );
  assert.equal(
    shouldAttachGitLabToken('http://172.20.1.5/group/template.git', ''),
    true,
  );
});

test('shouldAttachGitLabToken: 异常与空边界防御', () => {
  assert.equal(shouldAttachGitLabToken('', 'http://gitlab.example.com'), false);
  assert.equal(shouldAttachGitLabToken(null, 'http://gitlab.example.com'), false);
  assert.equal(shouldAttachGitLabToken('not-a-valid-url', 'http://gitlab.example.com'), false);
});

test('buildAuthenticatedRepoUrl: 对 GitHub 开源仓库保留公开免密地址', () => {
  const githubUrl = 'https://github.com/iamyancong/microapp-template-vue3.git';
  const token = 'glpat-secret-token-12345';
  const gitlabHost = 'http://192.168.167.142:8081';

  const result = buildAuthenticatedRepoUrl(githubUrl, token, gitlabHost);
  assert.equal(result, githubUrl);
  assert.doesNotMatch(result, /glpat-secret-token-12345/);
  assert.doesNotMatch(result, /oauth2/);
});

test('buildAuthenticatedRepoUrl: 对私有 GitLab 仓库正确注入 oauth2 凭证', () => {
  const privateUrl = 'http://192.168.167.142:8081/group/template.git';
  const token = 'glpat-secret-token-12345';
  const gitlabHost = 'http://192.168.167.142:8081';

  const result = buildAuthenticatedRepoUrl(privateUrl, token, gitlabHost);
  assert.equal(result, 'http://oauth2:glpat-secret-token-12345@192.168.167.142:8081/group/template.git');
});

test('buildAuthenticatedRepoUrl: 未提供 Token 时返回原始 URL', () => {
  const privateUrl = 'http://192.168.167.142:8081/group/template.git';
  assert.equal(buildAuthenticatedRepoUrl(privateUrl, '', 'http://192.168.167.142:8081'), privateUrl);
  assert.equal(buildAuthenticatedRepoUrl(privateUrl, null, 'http://192.168.167.142:8081'), privateUrl);
});
