import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveStderrLogLevel, splitProcessOutputLines, stripAnsi } from '../../utils/process-output.mjs';

test('stripAnsi 去除 Vite 在 CI=true 下输出的颜色控制码', () => {
  const raw = '\u001b[36mvite v6.0.5 \u001b[32mbuilding for production...\u001b[36m\u001b[39m';
  assert.equal(stripAnsi(raw), 'vite v6.0.5 building for production...');
});

test('stripAnsi 去除 OSC 超链接与孤立控制字符', () => {
  const raw = '\u001b]8;;https://vitejs.dev\u0007docs\u001b]8;;\u0007\u001b';
  assert.equal(stripAnsi(raw), 'docs');
});

test('splitProcessOutputLines 仅保留回车覆盖进度的最终内容', () => {
  const chunk = '\u001b[2K\rtransforming (12) a.ts\rtransforming (13) b.ts\n\n✓ 1024 modules transformed.\r\n';
  assert.deepEqual(splitProcessOutputLines(chunk), ['transforming (13) b.ts', '✓ 1024 modules transformed.']);
});

test('resolveStderrLogLevel: git / vite 正常进度不再误标为 warn', () => {
  for (const line of [
    'From http://192.168.167.142:8081/group/project',
    '* branch            dev        -> FETCH_HEAD',
    '+ 016ddbb...b2ebeff dev        -> origin/dev  (forced update)',
    'Cloning into \'workspace\'...',
    'transforming...',
  ]) {
    assert.equal(resolveStderrLogLevel(line), 'info', line);
  }
});

test('resolveStderrLogLevel: 告警语义保持 warn', () => {
  for (const line of [
    'WARN  deprecated eslint@8.57.0',
    'WARN  deprecated some-error-lib@1.0.0',
    'npm warn deprecated inflight@1.0.6',
    'warning: in the working copy of \'a.txt\', LF will be replaced by CRLF',
    '(!) Some chunks are larger than 500 kB after minification.',
    'Module level directives cause errors when bundled, "use client" in "node_modules/x/index.js" was ignored.',
    "<script src=\"/a.js\"> in \"/index.html\" can't be bundled without type=\"module\"",
  ]) {
    assert.equal(resolveStderrLogLevel(line), 'warn', line);
  }
});

test('resolveStderrLogLevel(#46): 导致失败的工具错误行判为 error', () => {
  for (const line of [
    // Issue #46 表格中的样例
    'RollupError: Could not resolve "./x" from "src/main.ts"',
    'Could not resolve "./x" from "src/main.ts"',
    'SyntaxError: Unexpected token (12:3)',
    'Killed',
    // 决策评论中列出的错误语义
    'error during build:',
    "fatal: Authentication failed for 'http://192.168.167.142:8081/group/app.git/'",
    'fatal: could not read Username',
    ' ELIFECYCLE  Command failed with exit code 1.',
    'ELIFECYCLE Command failed',
    'error Command failed with exit code 1.',
    'npm ERR! code ERESOLVE',
    'npm error code ERESOLVE',
    'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"',
    'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    'sh: line 1: 12345 Killed                  node node_modules/.bin/vite build',
    // \w*Error 类名（可带 [...] 前缀）
    'TypeError: Cannot read properties of undefined (reading \'map\')',
    '[vite:vue] SyntaxError: Unexpected token',
    '[vite:esbuild] Transform failed with 1 error:',
    '[plugin:vite:css] [postcss] CssSyntaxError: Unknown word',
    'Error [ERR_MODULE_NOT_FOUND]: Cannot find package \'foo\' imported from /app/vite.config.ts',
    'Error: Cannot find module \'@vitejs/plugin-vue\'',
    '[vite]: Rollup failed to resolve import "nope" from "/app/src/main.ts".',
    // 构建 / 编译失败
    'x Build failed in 262ms',
    '✗ Build failed',
    'src/a.ts(1,22): error TS2307: Cannot find module \'./b\' or its corresponding type declarations.',
    '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.8.1:compile',
    'src/main.ts:3:7: ERROR: Expected ";" but found "x"',
  ]) {
    assert.equal(resolveStderrLogLevel(line), 'error', line);
  }
});

test('resolveStderrLogLevel(#46): 普通进度与含 error 字样的普通行仍判 info，不误伤', () => {
  for (const line of [
    // 普通进度
    'vite v6.0.5 building for production...',
    'transforming...',
    '✓ 1024 modules transformed.',
    'rendering chunks...',
    'computing gzip size...',
    'remote: Enumerating objects: 5, done.',
    'Receiving objects: 100% (5/5), done.',
    'Progress: resolved 1024, reused 1000, downloaded 24, added 0',
    // 失败上下文行本身是 info（由前端失败上下文保护负责显示）
    'file: /app/src/views/a.vue:12:3',
    '    at getRollupError (file:///app/node_modules/rollup/dist/es/shared/parseAst.js:401:41)',
    'at error (file:///app/node_modules/rollup/dist/es/shared/parseAst.js:333:42)',
    'at async Promise.all (index 0)',
    '[vite:build-html] src/main.js (1:10): Expression expected',
    // 含 error 字样的普通行
    '0 errors',
    'Found 0 errors and 0 warnings.',
    'No errors found',
    'Errors: 0',
    'no-error',
    'dist/assets/error-boundary-Bx1c2.js   1.20 kB │ gzip: 0.62 kB',
    'dist/assets/ErrorPage-a1b2c3.css      0.31 kB',
    'eslint-plugin-no-fail-fast@1.0.0',
  ]) {
    assert.equal(resolveStderrLogLevel(line), 'info', line);
  }
});

test('runBackendLocalCommand: 工具输出标记 source=tool、去除 ANSI，stderr 按内容分 info / warn / error', async () => {
  const { runBackendLocalCommand } = await import('../backend-project-service.mjs');
  const entries = [];
  const script = [
    "process.stdout.write('\\u001b[32mBUILD OK\\u001b[39m\\n')",
    "process.stderr.write('From http://git.example.com/group/app\\n')",
    "process.stderr.write('WARN deprecated foo@1.0.0\\n')",
    "process.stderr.write('error during build:\\n')",
  ].join(';');
  await runBackendLocalCommand(`node -e "${script}"`, {
    label: '测试命令',
    onLog: (level, message, source) => entries.push({ level, message, source }),
  });
  // stdout / stderr 为两条独立管道，到达顺序不保证，按消息排序后断言
  entries.sort((a, b) => a.message.localeCompare(b.message));
  assert.deepEqual(entries, [
    { level: 'info', message: 'BUILD OK', source: 'tool' },
    { level: 'error', message: 'error during build:', source: 'tool' },
    { level: 'info', message: 'From http://git.example.com/group/app', source: 'tool' },
    { level: 'warn', message: 'WARN deprecated foo@1.0.0', source: 'tool' },
  ]);
});
