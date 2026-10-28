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

test('resolveStderrLogLevel: 告警与错误语义保持 warn', () => {
  for (const line of [
    'WARN  deprecated eslint@8.57.0',
    '(!) Some chunks are larger than 500 kB after minification.',
    'npm ERR! code ERESOLVE',
    'error during build:',
    'fatal: could not read Username',
    "<script src=\"/a.js\"> in \"/index.html\" can't be bundled without type=\"module\"",
    'x Build failed in 262ms',
    '✗ Build failed',
  ]) {
    assert.equal(resolveStderrLogLevel(line), 'warn', line);
  }
});

test('runBackendLocalCommand: 工具输出标记 source=tool、去除 ANSI，stderr 正常进度不标 warn', async () => {
  const { runBackendLocalCommand } = await import('../backend-project-service.mjs');
  const entries = [];
  const script = [
    "process.stdout.write('\\u001b[32mBUILD OK\\u001b[39m\\n')",
    "process.stderr.write('From http://git.example.com/group/app\\n')",
    "process.stderr.write('WARN deprecated foo@1.0.0\\n')",
  ].join(';');
  await runBackendLocalCommand(`node -e "${script}"`, {
    label: '测试命令',
    onLog: (level, message, source) => entries.push({ level, message, source }),
  });
  // stdout / stderr 为两条独立管道，到达顺序不保证，按消息排序后断言
  entries.sort((a, b) => a.message.localeCompare(b.message));
  assert.deepEqual(entries, [
    { level: 'info', message: 'BUILD OK', source: 'tool' },
    { level: 'info', message: 'From http://git.example.com/group/app', source: 'tool' },
    { level: 'warn', message: 'WARN deprecated foo@1.0.0', source: 'tool' },
  ]);
});
