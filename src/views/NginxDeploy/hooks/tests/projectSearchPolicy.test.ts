import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSearchKeyword,
  matchProjectCandidate,
  mergeAndDeduplicateProjects,
} from '../projectSearchPolicy.ts';
import type { GitLabProject } from '@/api/gitlab';

const mockProject = (partial: Partial<GitLabProject>): GitLabProject => ({
  id: partial.id || 1,
  name: partial.name || 'test-project',
  name_with_namespace: partial.name_with_namespace || 'group / test-project',
  path: partial.path || 'test-project',
  path_with_namespace: partial.path_with_namespace || 'group/test-project',
  description: partial.description || '',
  visibility: 'private',
  web_url: 'https://gitlab.example.com/group/test-project',
  ssh_url_to_repo: 'git@gitlab.example.com:group/test-project.git',
  http_url_to_repo: 'https://gitlab.example.com/group/test-project.git',
  readme_url: null,
  default_branch: 'main',
  tag_list: [],
  topics: [],
  owner: { id: 1, name: 'owner', username: 'owner', avatar_url: '', web_url: '' },
  creator_id: 1,
  namespace: { id: 1, name: 'group', path: 'group', kind: 'group', full_path: 'group', parent_id: null, avatar_url: null, web_url: '' },
  created_at: '',
  last_activity_at: '',
  forks_count: 0,
  star_count: 0,
  open_issues_count: 0,
  public_jobs: false,
  shared_with_groups: [],
  only_allow_merge_if_pipeline_succeeds: false,
  allow_merge_on_skipped_pipeline: false,
  only_allow_merge_if_all_discussions_are_resolved: false,
  remove_source_branch_after_merge: false,
  request_access_enabled: false,
  merge_method: 'merge',
  squash_option: 'default',
  auto_devops_enabled: false,
  auto_devops_deploy_strategy: 'continuous',
  repository_storage: 'default',
  has_vulnerability: false,
  compliance_frameworks: [],
  issues_template: null,
  merge_requests_template: null,
  ...partial,
} as unknown as GitLabProject);

test('normalizeSearchKeyword 应正确生成无空格紧凑变体', () => {
  const ctx1 = normalizeSearchKeyword('  p y  ');
  assert.equal(ctx1.rawKeyword, 'p y');
  assert.equal(ctx1.compactKeyword, 'py');
  assert.deepEqual(ctx1.variants, ['p y', 'py']);

  const ctx2 = normalizeSearchKeyword('py');
  assert.equal(ctx2.rawKeyword, 'py');
  assert.equal(ctx2.compactKeyword, 'py');
  assert.deepEqual(ctx2.variants, ['py']);

  const ctx3 = normalizeSearchKeyword('  ');
  assert.equal(ctx3.rawKeyword, '');
  assert.deepEqual(ctx3.variants, []);
});

test('matchProjectCandidate 应对拼音分词空格与短词进行容错匹配', () => {
  const pyjob = mockProject({ id: 101, name: 'pyjob', description: 'python 代码' });
  const zhboot = mockProject({ id: 102, name: 'zh-boot', description: '微服务后端' });

  // 1. 英文短词 py 命中 pyjob
  assert.equal(matchProjectCandidate(pyjob, 'py'), true);
  assert.equal(matchProjectCandidate(zhboot, 'py'), false);

  // 2. 中文输入法分词回车产生的 "p y" 容错命中 pyjob
  assert.equal(matchProjectCandidate(pyjob, 'p y'), true);

  // 3. 中文描述命中
  assert.equal(matchProjectCandidate(pyjob, 'python'), true);
  assert.equal(matchProjectCandidate(zhboot, '微服务'), true);

  // 4. 大小写不敏感
  assert.equal(matchProjectCandidate(pyjob, 'Py'), true);
  assert.equal(matchProjectCandidate(pyjob, 'PYJOB'), true);
});

test('mergeAndDeduplicateProjects 应优先保留本地匹配并按 ID 去重', () => {
  const p1 = mockProject({ id: 1, name: 'project-1' });
  const p2 = mockProject({ id: 2, name: 'project-2' });
  const p3 = mockProject({ id: 3, name: 'project-3' });

  const localMatches = [p1, p2];
  const remoteProjects = [p2, p3];

  const merged = mergeAndDeduplicateProjects(remoteProjects, localMatches);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.map((p) => p.id), [1, 2, 3]);
});
