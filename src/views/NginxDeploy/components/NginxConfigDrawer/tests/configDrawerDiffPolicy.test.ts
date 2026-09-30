import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calcMonacoLineChangesSummary,
  calcSimpleTextDiffSummary,
  formatDiffSummary,
  normalizeNginxContent,
} from '../constant.ts';

test('normalizeNginxContent 能正确消除换行符与行末空格差异', () => {
  const text1 = 'server {\r\n    listen 80;   \r\n    server_name localhost; \r\n}\r\n';
  const text2 = 'server {\n    listen 80;\n    server_name localhost;\n}';

  assert.equal(normalizeNginxContent(text1), normalizeNginxContent(text2));
});

test('normalizeNginxContent 针对实质指令变更保留差异', () => {
  const original = 'server {\n    listen 80;\n}';
  const modified = 'server {\n    listen 8080;\n}';

  assert.notEqual(normalizeNginxContent(original), normalizeNginxContent(modified));
});

test('calcMonacoLineChangesSummary 正确解析新增、删除与修改分块', () => {
  // 1. 空变更
  assert.deepEqual(calcMonacoLineChangesSummary([]), {
    changeCount: 0,
    addedLines: 0,
    removedLines: 0,
  });

  // 2. 纯新增 2 行（originalEndLineNumber = 0）
  const addChanges = [
    {
      originalStartLineNumber: 10,
      originalEndLineNumber: 0,
      modifiedStartLineNumber: 11,
      modifiedEndLineNumber: 12,
    },
  ];
  assert.deepEqual(calcMonacoLineChangesSummary(addChanges), {
    changeCount: 1,
    addedLines: 2,
    removedLines: 0,
  });

  // 3. 纯删除 1 行（modifiedEndLineNumber = 0）
  const removeChanges = [
    {
      originalStartLineNumber: 5,
      originalEndLineNumber: 5,
      modifiedStartLineNumber: 5,
      modifiedEndLineNumber: 0,
    },
  ];
  assert.deepEqual(calcMonacoLineChangesSummary(removeChanges), {
    changeCount: 1,
    addedLines: 0,
    removedLines: 1,
  });

  // 4. 多处混合变更（1 处替换 + 1 处新增）
  const mixedChanges = [
    {
      originalStartLineNumber: 3,
      originalEndLineNumber: 4, // 删 2 行
      modifiedStartLineNumber: 3,
      modifiedEndLineNumber: 3, // 增 1 行
    },
    {
      originalStartLineNumber: 8,
      originalEndLineNumber: 0,
      modifiedStartLineNumber: 8,
      modifiedEndLineNumber: 9, // 增 2 行
    },
  ];
  assert.deepEqual(calcMonacoLineChangesSummary(mixedChanges), {
    changeCount: 2,
    addedLines: 3,
    removedLines: 2,
  });
});

test('calcSimpleTextDiffSummary 在编辑态正确处理空白与行差异', () => {
  const orig = 'worker_processes 1;\nevents {}\n';
  // 仅在行末加空格和换行
  const blankMod = 'worker_processes 1;   \r\nevents {}\n\n';
  assert.deepEqual(calcSimpleTextDiffSummary(orig, blankMod), {
    changeCount: 0,
    addedLines: 0,
    removedLines: 0,
  });

  // 实质新增一行
  const actualMod = 'worker_processes 1;\nworker_rlimit_nofile 65535;\nevents {}\n';
  const summary = calcSimpleTextDiffSummary(orig, actualMod);
  assert.equal(summary.changeCount, 1);
  assert.equal(summary.addedLines, 1);
  assert.equal(summary.removedLines, 0);
});

test('calcSimpleTextDiffSummary 精确识别多个非连续独立修改处（3 处变更）', () => {
  const orig = [
    'worker_processes 1;',
    'error_log logs/error.log warn;',
    'events {',
    '    worker_connections 1024;',
    '}',
    'http {',
    '    sendfile on;',
    '    keepalive_timeout 65;',
    '    gzip on;',
    '}',
  ].join('\n');

  // 修改第 1 处：增加 worker_rlimit_nofile
  // 修改第 2 处：修改 worker_connections 1024 -> 2048
  // 修改第 3 处：删除 gzip on
  const modified = [
    'worker_processes 1;',
    'worker_rlimit_nofile 65535;', // +1
    'error_log logs/error.log warn;',
    'events {',
    '    worker_connections 2048;', // 替换（-1, +1）
    '}',
    'http {',
    '    sendfile on;',
    '    keepalive_timeout 65;',
    '}', // 删除了 gzip on (-1)
  ].join('\n');

  const summary = calcSimpleTextDiffSummary(orig, modified);
  assert.equal(summary.changeCount, 3, '应当准确识别为 3 处独立变更');
  assert.equal(summary.addedLines, 2, '新增 2 行（1 行全新 + 1 行替换）');
  assert.equal(summary.removedLines, 2, '删除 2 行（1 行替换 + 1 行删除）');
});

test('formatDiffSummary 输出规范的变更摘要文案', () => {
  assert.equal(formatDiffSummary({ changeCount: 0, addedLines: 0, removedLines: 0 }), '');
  assert.equal(
    formatDiffSummary({ changeCount: 2, addedLines: 3, removedLines: 1 }),
    '已改 2 处 · +3 −1'
  );
  assert.equal(
    formatDiffSummary({ changeCount: 3, addedLines: 2, removedLines: 2 }),
    '已改 3 处 · +2 −2'
  );
});
