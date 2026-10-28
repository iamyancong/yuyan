import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPLOY_LOG_HINT_RULES,
  presentDeployLogMessage,
  resolveDeployLogHint,
  shouldHideLevelTag,
  TOOL_LOG_PREFIX,
} from '../logPresentation.ts';
import { formatLogItem } from '../components/RecordLogDrawer/constant.ts';

test('resolveDeployLogHint: 截图中的 git 输出给出白话解释', () => {
  assert.match(resolveDeployLogHint('From http://192.168.167.142:8081/group/yss-valuation-outsourced'), /拉取最新代码/);
  assert.match(resolveDeployLogHint('* branch            dev        -> FETCH_HEAD'), /远端 dev 分支/);
  assert.match(
    resolveDeployLogHint('+ 016ddbb...b2ebeff dev        -> origin/dev  (forced update)'),
    /强制推送.*属正常现象/
  );
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
