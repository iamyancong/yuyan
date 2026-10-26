import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitLabBranch } from '@/api/gitlab';
import { BRANCH_PAGE_SIZE, collectMissingBranchNames, isBranchListTruncated, mergeBranches } from '../branchOptionsPolicy.ts';

const branch = (name: string, isDefault = false): GitLabBranch => ({ name, default: isDefault });

test('首页达到 100 条时判定为可能截断', () => {
  assert.equal(isBranchListTruncated(Array.from({ length: BRANCH_PAGE_SIZE - 1 }, (_, index) => branch(`b${index}`))), false);
  assert.equal(isBranchListTruncated(Array.from({ length: BRANCH_PAGE_SIZE }, (_, index) => branch(`b${index}`))), true);
});

test('合并分支去重且默认分支置顶', () => {
  const merged = mergeBranches([branch('a'), branch('dev')], [branch('dev', true), branch('b')]);
  assert.deepEqual(
    merged.map((item) => [item.name, Boolean(item.default)]),
    [
      ['dev', true],
      ['a', false],
      ['b', false],
    ]
  );
});

test('仅补齐未加载的必选分支并忽略空值', () => {
  assert.deepEqual(collectMissingBranchNames([branch('main'), branch('feature/x')], ['dev', 'main', '', null, 'dev', ' release ']), ['dev', 'release']);
});
