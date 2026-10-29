import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPLOY_LOG_CONTEXT_LEGEND,
  DEPLOY_LOG_HINT_RULES,
  DEPLOY_LOG_LEGEND,
  filterAttentionLogs,
  isDeployFailureEvent,
  presentDeployLogMessage,
  resolveDeployLogHint,
  shouldHideLevelTag,
  TOOL_CONTEXT_LOG_PREFIX,
  TOOL_LOG_PREFIX,
} from '../logPresentation.ts';
import { buildRecordLogView, formatLogItem } from '../components/RecordLogDrawer/constant.ts';
import type { DeployLogItem } from '../../../api/deploy.ts';

test('resolveDeployLogHint: 截图中的 git 输出给出白话解释', () => {
  assert.match(resolveDeployLogHint('From http://192.168.167.142:8081/group/yss-valuation-outsourced'), /拉取最新代码/);
  assert.match(resolveDeployLogHint('* branch            dev        -> FETCH_HEAD'), /远端 dev 分支/);
  const forcedHint = resolveDeployLogHint('+ 016ddbb...b2ebeff dev        -> origin/dev  (forced update)');
  assert.equal(forcedHint, '远端 dev 分支被强制更新（force push），已同步到最新提交，请确认部署的提交符合预期');
  assert.doesNotMatch(forcedHint, /正常现象/);
  assert.match(resolveDeployLogHint('016ddbb..b2ebeff  dev        -> origin/dev'), /已更新到远端最新提交/);
});

test('resolveDeployLogHint: npm 脚本与 vite 构建输出', () => {
  assert.equal(
    resolveDeployLogHint('> yss-valuation-outsourced-workspace@1.0.0 build /data/yuyan-ops/deploy-data/cache'),
    '开始执行 yss-valuation-outsourced-workspace 的 package.json 脚本「build」'
  );
  assert.equal(resolveDeployLogHint('> cd packages && pnpm build'), '该脚本实际执行的命令');
  assert.equal(resolveDeployLogHint('vite v6.0.5 building for production...'), '开始生产环境打包');
  assert.match(resolveDeployLogHint('✓ 1024 modules transformed.'), /共 1024 个模块/);
  assert.match(resolveDeployLogHint('✓ built in 12.34s'), /耗时 12.34s/);
});

test('resolveDeployLogHint: 雨燕系统术语', () => {
  assert.match(resolveDeployLogHint('构建内存预算池已预占 3072MB（上次峰值 10MB）'), /预留的内存/);
  assert.match(resolveDeployLogHint('依赖缓存命中，跳过安装依赖：957c4020216e'), /复用/);
});

test('resolveDeployLogHint: 未命中与多行消息不追加提示', () => {
  assert.equal(resolveDeployLogHint('普通日志'), '');
  assert.equal(resolveDeployLogHint('From a\nFrom b'), '');
  assert.equal(resolveDeployLogHint(''), '');
});

test('白话提示文案不包含会改变 Monaco 行颜色的级别关键字（除错误类规则外）', () => {
  const levelKeyword = /\b(FATAL|ERROR|ERR|FAILED|FAILURE|FAIL|EXCEPTION|WARN|WARNING|SUCCESS|DONE|INFO)\b/i;
  for (const rule of DEPLOY_LOG_HINT_RULES) {
    if (typeof rule.hint !== 'string') continue;
    if (/失败|出错|异常/.test(rule.hint)) continue;
    assert.doesNotMatch(rule.hint, levelKeyword, rule.hint);
  }
});

test('presentDeployLogMessage: 工具输出加 │ 前缀，提示追加在同一行', () => {
  const result = presentDeployLogMessage({ source: 'tool' }, 'vite v6.0.5 building for production...', true);
  assert.equal(result, `${TOOL_LOG_PREFIX}vite v6.0.5 building for production...  💡 开始生产环境打包`);
  assert.ok(!result.includes('\n'));
  assert.equal(presentDeployLogMessage({}, '已连接', true), '已连接');
  assert.equal(presentDeployLogMessage({ source: 'tool' }, 'vite v6.0.5 building', false), `${TOOL_LOG_PREFIX}vite v6.0.5 building`);
});

test('shouldHideLevelTag: 仅隐藏工具输出的 info 标签', () => {
  assert.equal(shouldHideLevelTag({ level: 'info', source: 'tool' }), true);
  assert.equal(shouldHideLevelTag({ level: 'warn', source: 'tool' }), false);
  assert.equal(shouldHideLevelTag({ level: 'info' }), false);
});

test('formatLogItem: 工具 info 行无级别与阶段标签，系统行保持原格式', () => {
  const tool = formatLogItem(
    { level: 'info', source: 'tool', stage: 'build', message: '\u001b[36mvite v6.0.5\u001b[39m building for production...', timestamp: '2026-10-28 09:46:14' },
    true
  );
  assert.ok(!/INFO|\[build\]|\u001b/.test(tool), tool);
  assert.ok(tool.includes('│ vite v6.0.5 building for production...  💡 开始生产环境打包'), tool);

  const system = formatLogItem({ level: 'info', stage: 'build', message: '构建产物', timestamp: '2026-10-28 09:46:11' });
  assert.ok(system.includes('INFO    [build] 构建产物'), system);
});

test('resolveDeployLogHint(#46): OOM 提示指向自动重试与「最低构建内存」，不再建议重装依赖', () => {
  const hint = resolveDeployLogHint('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory');
  assert.match(hint, /自动按更大内存重试/);
  assert.match(hint, /最低构建内存/);
  assert.doesNotMatch(hint, /重新安装依赖/);
});

test('DEPLOY_LOG_LEGEND(#46): 图例文案按决策修改', () => {
  const byLevel = Object.fromEntries(DEPLOY_LOG_LEGEND.map((item) => [item.level, item.description]));
  assert.equal(byLevel.error, '导致本次失败，优先查看');
  assert.equal(byLevel.warn, '可能有问题，不一定导致失败');
  assert.match(byLevel.tool, /工具原始输出，失败时请结合上下文查看/);
  assert.doesNotMatch(byLevel.tool, /一般无需关注/);
  assert.equal(DEPLOY_LOG_CONTEXT_LEGEND.level, 'context');
  assert.match(DEPLOY_LOG_CONTEXT_LEGEND.description, /┆/);
});

/** 构造日志项（缺省为雨燕系统日志） */
const log = (level: DeployLogItem['level'], message: string, source?: 'tool'): DeployLogItem => ({
  level,
  message,
  stage: 'build',
  timestamp: '2026-10-29 10:00:00',
  ...(source ? { source } : {}),
});

/**
 * 真实 Vite 6.0.5 构建失败（import 不存在的模块）的工具输出，级别为后端 resolveStderrLogLevel 的判级结果
 * （见补丁 README「真实验证」）。
 */
const VITE_IMPORT_FAILURE_LOGS: DeployLogItem[] = [
  log('info', '开始构建产物'),
  log('info', 'vite v6.0.5 building for production...', 'tool'),
  log('info', 'transforming...', 'tool'),
  log('info', '✓ 2 modules transformed.', 'tool'),
  log('error', 'x Build failed in 27ms', 'tool'),
  log('error', 'error during build:', 'tool'),
  log('error', 'Could not resolve "./not-exist-module" from "src/main.js"', 'tool'),
  log('info', 'file: /app/src/main.js', 'tool'),
  log('info', 'at getRollupError (file:///app/node_modules/rollup/dist/es/shared/parseAst.js:337:41)', 'tool'),
  log('info', 'at error (file:///app/node_modules/rollup/dist/es/shared/parseAst.js:333:42)', 'tool'),
  log('info', 'at async Promise.all (index 0)', 'tool'),
  log('error', '构建产物 执行失败，退出码 1'),
  log('info', '清理临时文件'),
  log('info', 'removed 3 files', 'tool'),
];

test('filterAttentionLogs(#46): error 后的 file: 定位行与堆栈作为上下文保留，到下一条系统日志截止', () => {
  const entries = filterAttentionLogs(VITE_IMPORT_FAILURE_LOGS);
  assert.deepEqual(
    entries.map(({ item, context }) => `${context ? 'ctx' : item.level}:${item.message}`),
    [
      'error:x Build failed in 27ms',
      'error:error during build:',
      'error:Could not resolve "./not-exist-module" from "src/main.js"',
      'ctx:file: /app/src/main.js',
      'ctx:at getRollupError (file:///app/node_modules/rollup/dist/es/shared/parseAst.js:337:41)',
      'ctx:at error (file:///app/node_modules/rollup/dist/es/shared/parseAst.js:333:42)',
      'ctx:at async Promise.all (index 0)',
      'error:构建产物 执行失败，退出码 1',
    ]
  );
  // error 之前的普通进度、下一条系统日志之后不相关的工具 info 行仍被过滤
  const messages = entries.map(({ item }) => item.message);
  assert.ok(!messages.includes('transforming...'));
  assert.ok(!messages.includes('removed 3 files'));
  assert.ok(!messages.includes('清理临时文件'));
});

test('filterAttentionLogs(#46): 只有工具 error 才开启保护，warn 与系统 error 不开启', () => {
  const entries = filterAttentionLogs([
    log('warn', 'WARN deprecated foo@1.0.0', 'tool'),
    log('info', 'Progress: resolved 10', 'tool'),
    log('error', '雨燕系统错误'),
    log('info', 'tool output after system error', 'tool'),
    log('error', 'fatal: Authentication failed', 'tool'),
    log('info', 'remote: hint', 'tool'),
    log('warn', 'warning: x', 'tool'),
    log('info', 'remote: more', 'tool'),
    log('success', '阶段完成'),
    log('info', 'later tool info', 'tool'),
  ]);
  assert.deepEqual(
    entries.map(({ item, context }) => `${context ? 'ctx' : item.level}:${item.message}`),
    [
      'warn:WARN deprecated foo@1.0.0',
      'error:雨燕系统错误',
      'error:fatal: Authentication failed',
      'ctx:remote: hint',
      'warn:warning: x',
      'ctx:remote: more',
    ]
  );
});

test('buildRecordLogView(#46): 「仅错误与告警」模式上下文行以 ┆ 标出并返回行号，「全部」模式不受影响', () => {
  const errorsView = buildRecordLogView(VITE_IMPORT_FAILURE_LOGS, 'errors');
  const lines = errorsView.text.split('\n');
  assert.equal(errorsView.count, 8);
  assert.equal(lines.length, 8);
  assert.deepEqual(errorsView.contextLineNumbers, [4, 5, 6, 7]);
  for (const lineNumber of errorsView.contextLineNumbers) {
    assert.ok(lines[lineNumber - 1].includes(TOOL_CONTEXT_LOG_PREFIX), lines[lineNumber - 1]);
  }
  assert.ok(lines[3].includes('┆ file: /app/src/main.js'), lines[3]);
  assert.ok(lines[2].includes(`ERROR   ${TOOL_LOG_PREFIX}Could not resolve`), lines[2]);
  assert.ok(lines[1].includes(`ERROR   ${TOOL_LOG_PREFIX}error during build:`), lines[1]);

  const allView = buildRecordLogView(VITE_IMPORT_FAILURE_LOGS, 'all');
  assert.equal(allView.count, VITE_IMPORT_FAILURE_LOGS.length);
  assert.deepEqual(allView.contextLineNumbers, []);
  assert.ok(!allView.text.includes(TOOL_CONTEXT_LOG_PREFIX));
  assert.deepEqual(
    allView.text.split('\n'),
    VITE_IMPORT_FAILURE_LOGS.map((item) => formatLogItem(item))
  );
});

test('buildRecordLogView: 多行历史消息按实际行号计算上下文行', () => {
  const view = buildRecordLogView(
    [
      log('error', 'error during build:', 'tool'),
      log('info', 'line a\nline b', 'tool'),
      log('info', 'file: /app/src/a.vue:1:1', 'tool'),
    ],
    'errors'
  );
  assert.deepEqual(view.contextLineNumbers, [2, 3, 4]);
});

test('isDeployFailureEvent(#46): 工具 error 行不代表发布失败，系统 error 与 error 事件才算', () => {
  assert.equal(isDeployFailureEvent({ type: 'log', level: 'error', source: 'tool' }), false);
  assert.equal(isDeployFailureEvent({ type: 'log', level: 'error' }), true);
  assert.equal(isDeployFailureEvent({ type: 'log', level: 'warn' }), false);
  assert.equal(isDeployFailureEvent({ type: 'error' }), true);
  assert.equal(isDeployFailureEvent({ type: 'stage' }), false);
});
