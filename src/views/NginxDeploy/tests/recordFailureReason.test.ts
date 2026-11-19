import assert from 'node:assert/strict';
import test from 'node:test';
import { describeRecordFailureReason, recordColumns } from '../constant.ts';

test('发布记录列表不设独立「失败原因」列，原因改由状态列悬浮展示', () => {
  const column = recordColumns.find((item) => item.field === 'errorSummary');
  assert.equal(column, undefined, '不应有独立的失败原因列');
  const statusColumn = recordColumns.find((item) => item.field === 'status');
  assert.ok(statusColumn, '应有状态列');
});

test('失败记录展示后端落库的分类与原因，悬浮提示带细节', () => {
  const view = describeRecordFailureReason({
    status: 'failed',
    errorSummary: {
      category: '依赖解析失败',
      title: '找不到依赖 axios',
      violation: 'axios',
      fileLocation: 'src/api/index.ts',
      failedStep: 'vite build',
      exitCode: 1,
      suggestion: '安装 axios 后重试',
    },
  });
  assert.equal(view?.category, '依赖解析失败');
  assert.equal(view?.title, '找不到依赖 axios');
  assert.equal(
    view?.tooltip,
    ['依赖解析失败：找不到依赖 axios', '涉及：axios', '位置：src/api/index.ts', '失败步骤：vite build', '退出码：1', '建议：安装 axios 后重试'].join('\n')
  );
});

test('成功记录、旧记录（无根因）不展示', () => {
  assert.equal(describeRecordFailureReason({ status: 'success', errorSummary: { category: 'x', title: 'y' } }), null);
  assert.equal(describeRecordFailureReason({ status: 'failed', errorSummary: null }), null);
  assert.equal(describeRecordFailureReason({ status: 'failed' }), null);
  assert.equal(describeRecordFailureReason(null), null);
});
