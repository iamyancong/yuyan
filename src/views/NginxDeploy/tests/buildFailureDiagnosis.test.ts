import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diagnoseBuildFailure,
  extractPackageName,
  splitCommandSteps,
  toRepoRelativePath,
} from '../buildFailureDiagnosis.ts';
import {
  buildRecordLogView,
  extractErrorSummaryFromLogs,
  findDiagnosticBannerLine,
  formatEditorDiagnosticBanner,
} from '../components/RecordLogDrawer/constant.ts';
// 复用后端真实的分行与 stderr 分级逻辑生成夹具（纯 JS 模块，无类型声明）
// @ts-expect-error 后端 .mjs 没有类型声明
import * as processOutput from '../../../../server/utils/process-output.mjs';
import type { DeployErrorSummary, DeployLogItem } from '../../../api/deploy.ts';

const splitProcessOutputLines = processOutput.splitProcessOutputLines as (chunk: string) => string[];
const resolveStderrLogLevel = processOutput.resolveStderrLogLevel as (line: string) => DeployLogItem['level'];

const WS = '/data/yuyan-ops/deploy-data/cache/workspaces/42/9f2c1a7b3e4d5f60/repo';
const TS = '2026-11-11T10:20:30.000Z';

type Chunk = { out?: string; err?: string };

/**
 * 按后端真实写法生成一次失败构建的日志：
 * stdout 行记 info、stderr 行按内容分级（source=tool），最后一条是雨燕失败汇总（重复 stderr || stdout）。
 */
function buildFailureLogs(options: {
  chunks: Chunk[];
  label?: string;
  code?: number | null;
  signal?: string;
  stage?: string;
  before?: DeployLogItem[];
}): DeployLogItem[] {
  const { chunks, label = '构建产物', code = 1, signal, stage = 'build', before = [] } = options;
  const logs: DeployLogItem[] = [
    { level: 'info', message: '操作人 ryan 发起发布', stage: 'validate', timestamp: TS },
    { level: 'info', message: '构建内存预算池已预占 2048MB（上次峰值 0MB，子进程堆上限 --max-old-space-size=2048）', stage: 'build', timestamp: TS },
    ...before,
  ];
  let stdout = '';
  let stderr = '';
  for (const chunk of chunks) {
    if (chunk.out !== undefined) {
      stdout += `${chunk.out}\n`;
      for (const line of splitProcessOutputLines(chunk.out)) logs.push({ level: 'info', message: line, stage, source: 'tool', timestamp: TS });
    }
    if (chunk.err !== undefined) {
      stderr += `${chunk.err}\n`;
      for (const line of splitProcessOutputLines(chunk.err)) {
        logs.push({ level: resolveStderrLogLevel(line) as DeployLogItem['level'], message: line, stage, source: 'tool', timestamp: TS });
      }
    }
  }
  const signalSuffix = code === null && signal ? `（信号 ${signal}）` : '';
  logs.push({ level: 'error', message: `${label} 执行失败，退出码 ${code}${signalSuffix}\n${(stderr || stdout).trim()}`, stage: 'error', timestamp: TS });
  return logs;
}

const diagnose = (logs: DeployLogItem[]) => diagnoseBuildFailure(logs, { record: { status: 'failed' } });

/** 断言 lineIndex 指向 Monaco「全部日志」中包含指定文本的那一行 */
function assertLineIndexPointsTo(logs: DeployLogItem[], summary: DeployErrorSummary | null, text: string) {
  const view = buildRecordLogView(logs, 'all').text.split('\n');
  assert.ok(summary?.lineIndex, 'lineIndex 应存在');
  assert.ok(view[summary!.lineIndex! - 1].includes(text), `第 ${summary!.lineIndex} 行应包含 ${text}，实际：${view[summary!.lineIndex! - 1]}`);
}

const SCREENSHOT_STDOUT = `
> packages@0.0.0 build ${WS}/packages
> vite build && node ../scripts/precompress-dist.mjs dist && node ../scripts/check-page-budget.mjs dist
`;
const SCREENSHOT_STDERR = `failed to load config from ${WS}/packages/vite.config.ts
error during build:
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'unplugin-vue-components' imported from ${WS}/packages/vite.config.ts.timestamp-1762848000000-8f3a2b1c9d0e.mjs
    at packageResolve (node:internal/modules/esm/resolve:873:9)
    at moduleResolve (node:internal/modules/esm/resolve:946:18)
    at defaultResolve (node:internal/modules/esm/resolve:1188:11)
    at ModuleLoader.defaultResolve (node:internal/modules/esm/loader:642:12)
    at #cachedDefaultResolve (node:internal/modules/esm/loader:591:25)
    at ModuleLoader.resolve (node:internal/modules/esm/loader:574:38)
    at ModuleLoader.getModuleJobForImport (node:internal/modules/esm/loader:236:38)
    at ModuleJob._link (node:internal/modules/esm/module_job:130:49)
 ELIFECYCLE  Command failed with exit code 1.`;

test('#58 截图案例：vite.config.ts 缺 unplugin-vue-components，判为依赖缺失而不是性能预算门禁', () => {
  const logs = buildFailureLogs({ chunks: [{ out: SCREENSHOT_STDOUT }, { err: SCREENSHOT_STDERR }] });
  const summary = extractErrorSummaryFromLogs(logs, { status: 'failed' } as any);
  assert.ok(summary);
  assert.equal(summary.category, '依赖缺失');
  assert.notEqual(summary.category, '性能预算门禁');
  assert.equal(summary.violation, 'unplugin-vue-components');
  assert.equal(summary.fileLocation, 'packages/vite.config.ts');
  assert.equal(summary.failedCommand, 'vite build && node ../scripts/precompress-dist.mjs dist && node ../scripts/check-page-budget.mjs dist');
  assert.equal(summary.failedStep, 'vite build');
  assert.deepEqual(summary.skippedSteps, ['node ../scripts/precompress-dist.mjs dist', 'node ../scripts/check-page-budget.mjs dist']);
  assert.equal(summary.exitCode, 1);
  assert.match(summary.suggestion!, /packages\/package\.json/);
  assert.match(summary.suggestion!, /锁文件/);
  assertLineIndexPointsTo(logs, summary, 'Error [ERR_MODULE_NOT_FOUND]');

  const banner = formatEditorDiagnosticBanner(summary);
  assert.ok(!banner.includes('性能预算门禁'));
  assert.ok(!banner.includes('check-page-budget') || banner.includes('未执行'), '预算脚本只能以“未执行”出现');
  assert.ok(banner.includes('[ERROR] 失败步骤: vite build（后续 node ../scripts/precompress-dist.mjs dist、node ../scripts/check-page-budget.mjs dist 未执行）'));
  assert.ok(banner.includes('[INFO]  失败命令: vite build && node'));
  assert.ok(banner.includes('[INFO]  退出码: 1'));
  const excerptPart = banner.slice(banner.indexOf('原始报错输出'));
  assert.ok(excerptPart.includes('│ failed to load config from'));
  assert.ok(excerptPart.includes('│ Error [ERR_MODULE_NOT_FOUND]: Cannot find package'));
  assert.ok(excerptPart.includes('│     at packageResolve (node:internal/modules/esm/resolve:873:9)'));
  assert.ok(!excerptPart.includes('> vite build &&'));
  assert.ok(!excerptPart.includes('ELIFECYCLE'));
  for (const bannerLine of banner.split('\n').filter(Boolean)) {
    assert.equal(bannerLine, bannerLine.trimStart(), `诊断横幅行不应存在前导空格: "${bannerLine}"`);
  }
});

test('真实页面预算超限：vite 打包成功、预算脚本自己报超限，才判为性能预算门禁', () => {
  const logs = buildFailureLogs({
    chunks: [
      { out: SCREENSHOT_STDOUT },
      { out: 'vite v5.4.10 building for production...\ntransforming...\n✓ 1324 modules transformed.\nrendering chunks...\ndist/assets/index-Bx1.js  612.30 kB │ gzip: 201.11 kB\n✓ built in 21.34s' },
      { out: '[precompress] 144 个文件，生成 234 个静态压缩文件' },
      { err: `[page-budget] 页面预算超出：/home 首屏 JS 612.3KB > 500KB\nfile://${WS}/scripts/check-page-budget.mjs:88\n    throw new Error(\`页面预算超出 \${n} 项\`);\n    ^\n\nError: 页面预算超出 1 项\n    at main (file://${WS}/scripts/check-page-budget.mjs:88:11)\n\nNode.js v20.11.0\n ELIFECYCLE  Command failed with exit code 1.` },
    ],
  });
  const summary = diagnose(logs);
  assert.equal(summary?.category, '性能预算门禁');
  assert.equal(summary?.stage, 'check-page-budget');
  assert.equal(summary?.failedStep, 'node ../scripts/check-page-budget.mjs dist');
  assert.equal(summary?.skippedSteps, undefined);
  assert.match(summary!.violation!, /612\.3KB > 500KB/);
});

test('预算脚本抛错但没有“预算”字样：按堆栈出自 check-page-budget 判定', () => {
  const logs = buildFailureLogs({
    chunks: [
      { out: SCREENSHOT_STDOUT },
      { out: '✓ built in 9.1s\n[precompress] done' },
      { err: `Error: /home gzip 体积 312KB 超过上限 250KB\n    at check (file://${WS}/scripts/check-page-budget.mjs:40:9)` },
    ],
  });
  const summary = diagnose(logs);
  assert.equal(summary?.category, '性能预算门禁');
  assert.equal(summary?.failedStep, 'node ../scripts/check-page-budget.mjs dist');
});

test('vite 打包报 Rollup 错误时，命令里有 check-page-budget 也不能判成预算问题', () => {
  const logs = buildFailureLogs({
    chunks: [
      { out: SCREENSHOT_STDOUT },
      { out: 'vite v5.4.10 building for production...' },
      { err: `x Build failed in 1.2s\nerror during build:\n[vite]: Rollup failed to resolve import "axios" from "${WS}/packages/src/api/http.ts".\nThis is most likely unintended because it can break your application at runtime.` },
    ],
  });
  const summary = diagnose(logs);
  assert.equal(summary?.category, '依赖缺失');
  assert.equal(summary?.violation, 'axios');
  assert.equal(summary?.fileLocation, 'packages/src/api/http.ts');
  assert.equal(summary?.failedStep, 'vite build');
  assert.match(summary!.excerpt!, /^x Build failed in 1\.2s\nerror during build:\n\[vite\]: Rollup failed/);
});

test('依赖缺失：CJS Cannot find module + Require stack、相对路径、node_modules 内部、scoped 子路径', () => {
  const cjs = diagnose(buildFailureLogs({ chunks: [{ err: `Error: Cannot find module 'lodash-es'\nRequire stack:\n- ${WS}/scripts/gen-icons.cjs\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1145:15)` }] }));
  assert.equal(cjs?.category, '依赖缺失');
  assert.equal(cjs?.violation, 'lodash-es');
  assert.equal(cjs?.fileLocation, 'scripts/gen-icons.cjs');

  const relative = diagnose(buildFailureLogs({ chunks: [{ err: `Error: Cannot find module './utils/format' imported from ${WS}/src/main.mjs` }] }));
  assert.equal(relative?.category, '模块导入失败');
  assert.equal(relative?.violation, './utils/format');
  assert.equal(relative?.fileLocation, 'src/main.mjs');

  const nested = diagnose(buildFailureLogs({ chunks: [{ err: `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'picomatch' imported from ${WS}/node_modules/.pnpm/unplugin@1.0.0/node_modules/unplugin/dist/index.mjs` }] }));
  assert.equal(nested?.category, '依赖缺失');
  assert.match(nested!.title, /依赖包 unplugin 需要的 picomatch/);
  assert.match(nested!.suggestion!, /重新安装依赖/);

  const scoped = diagnose(buildFailureLogs({ chunks: [{ err: `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@vitejs/plugin-vue/dist/index.mjs' imported from ${WS}/vite.config.ts.timestamp-1-ab12.mjs` }] }));
  assert.equal(scoped?.violation, '@vitejs/plugin-vue');
  assert.equal(scoped?.fileLocation, 'vite.config.ts');
  assert.match(scoped!.suggestion!, /在 package\.json 的 devDependencies/);
});

test('导入解析失败：Failed to resolve import 相对路径与 Failed to resolve entry 保持原分类', () => {
  const rel = diagnose(buildFailureLogs({ chunks: [{ err: '[vite:import-analysis] Failed to resolve import "./components/Foo.vue" from "src/App.vue". Does the file exist?\nfile: /x/src/App.vue:3:17' }] }));
  assert.equal(rel?.category, '模块导入失败');
  assert.equal(rel?.violation, './components/Foo.vue');
  assert.equal(rel?.fileLocation, 'src/App.vue');

  const entry = diagnose(buildFailureLogs({ chunks: [{ err: 'x Build failed in 262ms\nerror during build:\n[commonjs--resolver] Failed to resolve entry for package "@vue-office/excel". The package may have incorrect main/module/exports specified in its package.json.' }] }));
  assert.equal(entry?.category, '依赖解析失败');
  assert.equal(entry?.violation, '@vue-office/excel');
});

test('锁文件不一致：OUTDATED_LOCKFILE / BREAKING_CHANGE / npm ci', () => {
  const outdated = diagnose(buildFailureLogs({
    label: '下载依赖',
    stage: 'install',
    chunks: [{ err: ' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with packages/package.json\n\nNote that in CI environments this setting is true by default.' }],
  }));
  assert.equal(outdated?.category, '锁文件不一致');
  assert.equal(outdated?.stage, 'install');
  assert.equal(outdated?.fileLocation, 'packages/package.json');
  assert.match(outdated!.suggestion!, /锁文件一起提交/);

  const breaking = diagnose(buildFailureLogs({ chunks: [{ err: ' ERR_PNPM_LOCKFILE_BREAKING_CHANGE  Lockfile /x/pnpm-lock.yaml not compatible with current pnpm' }] }));
  assert.equal(breaking?.title, '锁文件格式与服务器 pnpm 版本不兼容');

  const npmCi = diagnose(buildFailureLogs({ chunks: [{ err: 'npm error code EUSAGE\nnpm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.' }] }));
  assert.equal(npmCi?.category, '锁文件不一致');
});

test('依赖下载失败：404 / 401 / 超时 / DNS，且安装重试的 WARN 不抢主因', () => {
  assert.equal(diagnose(buildFailureLogs({ chunks: [{ err: ' ERR_PNPM_FETCH_404  GET https://registry.npmmirror.com/@yss%2fui: Not Found - 404' }] }))?.title, '依赖包或版本在 npm 源上不存在');
  assert.equal(diagnose(buildFailureLogs({ chunks: [{ err: ' ERR_PNPM_FETCH_401  GET https://npm.corp.local/@yss%2fui: Unauthorized - 401' }] }))?.title, 'npm 私服鉴权失败（401/403）');
  const timeout = diagnose(buildFailureLogs({ chunks: [{ err: ' ERR_PNPM_META_FETCH_FAIL  GET https://npm.corp.local/vue: request to https://npm.corp.local/vue failed, reason: connect ETIMEDOUT 10.0.0.8:443' }] }));
  assert.equal(timeout?.category, '依赖下载失败');
  assert.equal(timeout?.title, '连接 npm 源超时或被断开');
  assert.equal(diagnose(buildFailureLogs({ chunks: [{ err: 'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/vue failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org' }] }))?.title, 'npm 源域名解析失败');

  const retried = diagnose(buildFailureLogs({
    chunks: [
      { err: ' WARN  GET https://npm.corp.local/vue error (ETIMEDOUT). Will retry in 10 seconds. 2 retries left.' },
      { err: 'src/main.ts(3,1): error TS2304: Cannot find name \'foo\'.' },
    ],
  }));
  assert.equal(retried?.category, 'TypeScript 类型错误');
});

test('Node 版本不符：Vite 要求、engines、低版本缺 API', () => {
  const vite = diagnose(buildFailureLogs({ chunks: [{ err: 'You are using Node.js 16.20.2. Vite requires Node.js version 18+ or 20+. Please upgrade your Node.js version.' }] }));
  assert.equal(vite?.category, 'Node 版本不符');
  assert.match(vite!.violation!, /当前 16\.20\.2/);
  assert.match(vite!.violation!, /要求 18\+ or 20\+|要求 18\+/);

  const engine = diagnose(buildFailureLogs({ chunks: [{ err: ' ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported environment (bad pnpm and/or Node.js version)' }] }));
  assert.equal(engine?.category, 'Node 版本不符');

  const api = diagnose(buildFailureLogs({ chunks: [{ err: `error during build:\nTypeError: crypto$2.getRandomValues is not a function\n    at resolveConfig (file://${WS}/node_modules/vite/dist/node/chunks/dep.js:63333:22)` }] }));
  assert.equal(api?.category, 'Node 版本不符');
  assert.match(api!.suggestion!, /18/);
});

test('缺少脚本、命令未安装（含中文 Windows 提示）', () => {
  const missing = diagnose(buildFailureLogs({ chunks: [{ err: ' ERR_PNPM_NO_SCRIPT  Missing script: build\n\nCommand "build" not found.' }] }));
  assert.equal(missing?.category, '缺少脚本');
  assert.equal(missing?.violation, 'build');

  const npmMissing = diagnose(buildFailureLogs({ chunks: [{ err: 'npm error Missing script: "build:prod"' }] }));
  assert.equal(npmMissing?.violation, 'build:prod');

  const sh = diagnose(buildFailureLogs({ code: 127, chunks: [{ out: '\n> app@1.0.0 build /x\n> vite build\n' }, { err: 'sh: 1: vite: not found\n ELIFECYCLE  Command failed.' }] }));
  assert.equal(sh?.category, '命令未安装');
  assert.equal(sh?.violation, 'vite');
  assert.equal(sh?.exitCode, 127);

  const win = diagnose(buildFailureLogs({ chunks: [{ err: "'vue-tsc' 不是内部或外部命令，也不是可运行的程序\n或批处理文件。" }] }));
  assert.equal(win?.violation, 'vue-tsc');
});

test('TypeScript：stdout 里的 vue-tsc 报错，定位到第一条并统计其余', () => {
  const logs = buildFailureLogs({
    chunks: [
      { out: '\n> app@1.0.0 build /x\n> vue-tsc --noEmit && vite build\n' },
      { out: "src/views/Home.vue(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/views/Home.vue(20,1): error TS2304: Cannot find name 'foo'.\nsrc/api/a.ts:3:7 - error TS2307: Cannot find module '@/missing' or its corresponding type declarations.\n\nFound 3 errors in 2 files." },
      { err: ' ELIFECYCLE  Command failed with exit code 2.' },
    ],
    code: 2,
  });
  const summary = diagnose(logs);
  assert.equal(summary?.category, 'TypeScript 类型错误');
  assert.equal(summary?.fileLocation, 'src/views/Home.vue:12:5');
  assert.match(summary!.violation!, /^TS2322/);
  assert.equal(summary?.otherErrorCount, 2);
  assert.equal(summary?.failedStep, 'vue-tsc --noEmit');
  assert.deepEqual(summary?.skippedSteps, ['vite build']);
  assert.equal(summary?.exitCode, 2);
  assertLineIndexPointsTo(logs, summary, 'error TS2322');
  assert.match(formatEditorDiagnosticBanner(summary!), /另有 2 处报错/);
});

test('语法 / 转换错误：esbuild、Transform failed、vite:vue', () => {
  const esb = diagnose(buildFailureLogs({ chunks: [{ err: '✘ [ERROR] Expected ";" but found "}"\n\n    src/main.ts:10:2:\n      10 │   foo(}\n         ╵   ^' }] }));
  assert.equal(esb?.category, '语法/转换错误');
  assert.equal(esb?.fileLocation, 'src/main.ts:10:2');

  const transform = diagnose(buildFailureLogs({ chunks: [{ err: `error during build:\n[vite:esbuild] Transform failed with 1 error:\n${WS}/src/utils/a.ts:3:7: ERROR: Unexpected "<"` }] }));
  assert.equal(transform?.category, '语法/转换错误');
  assert.equal(transform?.fileLocation, 'src/utils/a.ts:3:7');
  assert.equal(transform?.violation, 'Unexpected "<"');

  const vue = diagnose(buildFailureLogs({ chunks: [{ err: `[vite:vue] Element is missing end tag.\nfile: ${WS}/src/views/List.vue:14:3` }] }));
  assert.equal(vue?.title, 'Vue 组件编译失败');
  assert.equal(vue?.fileLocation, 'src/views/List.vue:14:3');
});

test('样式编译错误：sass / less', () => {
  const sass = diagnose(buildFailureLogs({ chunks: [{ err: '[vite:css] [sass] Undefined variable.\n  ╷\n12 │   color: $primary;\n  │          ^^^^^^^^\n  ╵\n  src/styles/index.scss 12:10  root stylesheet' }] }));
  assert.equal(sass?.category, '样式编译错误');
  assert.equal(sass?.fileLocation, 'src/styles/index.scss:12:10');

  const less = diagnose(buildFailureLogs({ chunks: [{ err: `[vite:css] [less] variable @primary is undefined in ${WS}/src/theme.less on line 3, column 10:` }] }));
  assert.equal(less?.category, '样式编译错误');
  assert.equal(less?.fileLocation, 'src/theme.less:3:10');
});

test('内存：Node 堆溢出保留原分类与自动重试文案；SIGKILL / 137 单独归类', () => {
  const oom = diagnose(buildFailureLogs({
    code: null,
    signal: 'SIGABRT',
    chunks: [{ err: '<--- Last few GCs --->\nFATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory' }],
  }));
  assert.equal(oom?.category, '构建内存溢出');
  assert.match(oom!.suggestion!, /自动按更大内存重试/);
  assert.equal(oom?.exitCode, 'SIGABRT');

  const killed = diagnose(buildFailureLogs({ code: 137, chunks: [{ out: 'transforming (3121) src/a.ts' }, { err: 'Killed' }] }));
  assert.equal(killed?.category, '进程被系统终止');

  const silentKill = diagnose(buildFailureLogs({ code: null, signal: 'SIGKILL', chunks: [] }));
  assert.equal(silentKill?.category, '进程被系统终止');
  assert.equal(silentKill?.exitCode, 'SIGKILL');
  assert.match(formatEditorDiagnosticBanner(silentKill!), /退出信号: SIGKILL/);
});

test('系统资源：磁盘满、inotify 上限、权限不足', () => {
  assert.equal(diagnose(buildFailureLogs({ chunks: [{ err: "Error: ENOSPC: no space left on device, write" }] }))?.category, '磁盘空间不足');
  assert.equal(diagnose(buildFailureLogs({ chunks: [{ err: 'Error: ENOSPC: System limit for number of file watchers reached, watch \'/x\'' }] }))?.category, '系统资源限制');
  const perm = diagnose(buildFailureLogs({ chunks: [{ err: `Error: EACCES: permission denied, mkdir '${WS}/node_modules/.vite'` }] }));
  assert.equal(perm?.category, '权限不足');
  assert.equal(perm?.violation, 'node_modules/.vite');
});

test('兜底：无法识别时给出退出码与末尾原始输出；完全无输出时说明', () => {
  const unknown = diagnose(buildFailureLogs({ code: 2, chunks: [{ out: 'generating sitemap...\nsomething odd happened here' }] }));
  assert.equal(unknown?.category, '执行失败');
  assert.match(unknown!.title, /退出码 2/);
  assert.match(unknown!.excerpt!, /something odd happened here/);

  // 第 2 条命令没有任何输出就以退出码 1 结束（第 1 条命令的输出不算）
  const empty = diagnose(buildFailureLogs({
    code: 1,
    label: '构建产物 2/2',
    before: [
      { level: 'info', message: '执行构建产物 1/2：pnpm run gen', stage: 'build', timestamp: TS },
      { level: 'info', message: 'generated 12 files', stage: 'build', source: 'tool', timestamp: TS },
      { level: 'info', message: '执行构建产物 2/2：bash ./deploy-check.sh', stage: 'build', timestamp: TS },
    ],
    chunks: [],
  }));
  assert.equal(empty?.category, '执行失败');
  assert.match(empty!.title, /退出码 1/);
  assert.match(empty!.suggestion!, /没有输出任何报错/);
  assert.equal(empty?.excerpt, undefined);
  assert.equal(empty?.failedCommand, 'bash ./deploy-check.sh');
});

test('边界：像错误的普通行不抢主因（0 errors、ErrorBoundary 路径、(!) 告警、deprecated、堆栈函数名）', () => {
  const summary = diagnose(buildFailureLogs({
    chunks: [
      { out: 'dist/assets/ErrorBoundary-a1b2.js   1.20 kB │ gzip: 0.6 kB\ndist/assets/error-page-x9.css  0.3 kB\nFound 0 errors.' },
      { err: ' WARN  deprecated error-ex@1.3.2\n(!) Some chunks are larger than 500 kB after minification.\nat error (file:///x/node_modules/rollup/dist/es/shared/node-entry.js:1:1)' },
      { err: "src/router/index.ts(8,3): error TS2322: Type 'number' is not assignable to type 'string'." },
    ],
  }));
  assert.equal(summary?.category, 'TypeScript 类型错误');
  assert.equal(summary?.fileLocation, 'src/router/index.ts:8:3');
});

test('边界：旧记录只有一坨汇总消息（无 source）+ ANSI + CRLF', () => {
  const message = `构建产物 执行失败，退出码 1\r\n\u001b[31mfailed to load config from ${WS}/vite.config.ts\u001b[39m\r\n\u001b[31merror during build:\u001b[39m\r\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'unplugin-auto-import' imported from ${WS}/vite.config.ts.timestamp-1762848000000-ab.mjs\r\n    at packageResolve (node:internal/modules/esm/resolve:873:9)`;
  const logs: DeployLogItem[] = [
    { level: 'info', message: '> app@1.0.0 build', timestamp: TS },
    { level: 'info', message: '> vite build && node scripts/check-page-budget.mjs', timestamp: TS },
    { level: 'error', message, timestamp: TS },
  ];
  const summary = diagnose(logs);
  assert.equal(summary?.category, '依赖缺失');
  assert.equal(summary?.violation, 'unplugin-auto-import');
  assert.equal(summary?.fileLocation, 'vite.config.ts');
  assert.equal(summary?.failedStep, 'vite build');
  assert.ok(!summary?.excerpt?.includes('\u001b'));
  assert.ok(!summary?.excerpt?.includes('\r'));
});

test('边界：超长日志（3 万行进度）后的第一条报错不漏，且耗时可控', () => {
  const noise = Array.from({ length: 30000 }, (_, i) => `transforming (${i}) src/modules/m${i}.ts`).join('\n');
  const started = Date.now();
  const summary = diagnose(buildFailureLogs({ chunks: [{ out: noise }, { err: `error during build:\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'sass' imported from ${WS}/node_modules/vite/dist/node/chunks/dep.js` }] }));
  assert.ok(Date.now() - started < 3000, '超长日志诊断应在 3 秒内完成');
  assert.equal(summary?.category, '依赖缺失');
  assert.equal(summary?.violation, 'sass');

  const longLine = `Error: ${'x'.repeat(200000)}`;
  const long = diagnose(buildFailureLogs({ chunks: [{ err: longLine }] }));
  assert.equal(long?.category, '异常抛错');
  assert.ok(long!.violation!.length <= 302);
});

test('边界：tsc 一次报几万条错误时取第一条', () => {
  const errors = Array.from({ length: 25000 }, (_, i) => `src/gen/f${i}.ts(1,1): error TS2304: Cannot find name 'x${i}'.`).join('\n');
  const summary = diagnose(buildFailureLogs({ chunks: [{ out: errors }] }));
  assert.equal(summary?.fileLocation, 'src/gen/f0.ts:1:1');
  assert.ok((summary?.otherErrorCount ?? 0) <= 99);
});

test('边界：多行命令只在失败那一条命令的输出段内归因', () => {
  const logs = buildFailureLogs({
    label: '构建产物 2/2',
    before: [
      { level: 'info', message: '执行构建产物 1/2：pnpm run gen', stage: 'build', timestamp: TS },
      { level: 'warn', message: 'Error: optional generator skipped', stage: 'build', source: 'tool', timestamp: TS },
      { level: 'info', message: '执行构建产物 2/2：pnpm build', stage: 'build', timestamp: TS },
    ],
    chunks: [{ out: '\n> app@1.0.0 build /x\n> vite build\n' }, { err: 'sh: 1: vite: not found' }],
  });
  const summary = diagnose(logs);
  assert.equal(summary?.category, '命令未安装');
  assert.equal(summary?.failedCommand, 'vite build');
});

test('边界：Windows 路径与反斜杠', () => {
  const summary = diagnose(buildFailureLogs({
    chunks: [{ err: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'unplugin-vue-components' imported from C:\\Users\\a\\AppData\\yuyan\\deploy-data\\cache\\workspaces\\3\\ab12\\repo\\web\\vite.config.ts.timestamp-1762848000000-ab.mjs" }],
  }));
  assert.equal(summary?.fileLocation, 'web/vite.config.ts');
  assert.match(summary!.suggestion!, /web\/package\.json/);
});

test('多个不同报错：主因 + 其余计数（同一报错重复不计）', () => {
  const summary = diagnose(buildFailureLogs({
    chunks: [{ err: `[vite]: Rollup failed to resolve import "axios" from "${WS}/src/a.ts".\n[vite]: Rollup failed to resolve import "axios" from "${WS}/src/a.ts".\n[vite]: Rollup failed to resolve import "dayjs" from "${WS}/src/b.ts".` }],
  }));
  assert.equal(summary?.violation, 'axios');
  assert.equal(summary?.otherErrorCount, 1);
});

test('非命令失败（如上传阶段）沿用旧兜底；未失败不出诊断；已有 errorSummary 直接复用', () => {
  const logs: DeployLogItem[] = [
    { level: 'info', message: '开始上传', timestamp: TS },
    { level: 'error', message: 'SFTP 上传中断', timestamp: TS },
  ];
  assert.equal(extractErrorSummaryFromLogs(logs, { status: 'failed' } as any)?.category, '执行失败');
  assert.equal(extractErrorSummaryFromLogs(logs, { status: 'success' } as any), null);
  assert.equal(extractErrorSummaryFromLogs([], { status: 'failed' } as any), null);
  const existing = { category: '自定义', title: '后端诊断' };
  assert.equal(extractErrorSummaryFromLogs(logs, { status: 'failed', errorSummary: existing } as any), existing);
});

test('摘录超出上限时提示省略行数', () => {
  const frames = Array.from({ length: 40 }, (_, i) => `    at fn${i} (file://${WS}/scripts/build.mjs:${i + 1}:1)`).join('\n');
  const summary = diagnose(buildFailureLogs({ chunks: [{ err: `Error: boom\n${frames}` }] }));
  assert.equal(summary?.excerpt?.split('\n').length, 20);
  assert.equal(summary?.excerptOmittedLines, 21);
  assert.equal(summary?.fileLocation, 'scripts/build.mjs:1:1');
  assert.match(formatEditorDiagnosticBanner(summary!), /… 其余 21 行见上方日志/);
});

test('工具函数：路径清洗、包名提取、命令拆分（引号内不拆）', () => {
  assert.equal(toRepoRelativePath(`file://${WS}/packages/vite.config.ts.timestamp-1762848000000-8f3a2b1c9d0e.mjs`), 'packages/vite.config.ts');
  assert.equal(toRepoRelativePath(`${WS}/src/a.ts:12:5`), 'src/a.ts:12:5');
  assert.equal(toRepoRelativePath('/opt/other/src/a.ts'), '/opt/other/src/a.ts');
  assert.equal(extractPackageName('@scope/pkg/sub/path'), '@scope/pkg');
  assert.equal(extractPackageName('pkg/sub'), 'pkg');
  assert.deepEqual(splitCommandSteps('vite build && node a.mjs "x && y" ; echo ok || true'), {
    steps: ['vite build', 'node a.mjs "x && y"', 'echo ok', 'true'],
    separators: ['&&', ';', '||'],
  });
});

test('findDiagnosticBannerLine：按标题定位诊断报告所在行', () => {
  const summary = diagnose(buildFailureLogs({ chunks: [{ err: 'Error: boom' }] }))!;
  const content = `a\nb\nc\n${formatEditorDiagnosticBanner(summary)}`;
  const line = findDiagnosticBannerLine(content);
  assert.ok(content.split('\n')[line - 1].includes('雨燕构建未通过诊断报告'));
  assert.equal(findDiagnosticBannerLine('no banner'), 0);
});

test('旧记录（无 source 标记）：按阶段与雨燕分界日志分段，安装阶段的报错不会被当成构建失败原因', () => {
  const logs: DeployLogItem[] = [
    { level: 'info', message: '操作人 ryan 发起发布', stage: 'validate', timestamp: TS },
    { level: 'warn', message: 'npm ERR! network request to https://npm.corp.local/x failed, reason: connect ETIMEDOUT', stage: 'install', timestamp: TS },
    { level: 'success', message: '依赖安装完成，已更新依赖缓存指纹：abcdef123456', stage: 'install', timestamp: TS },
    { level: 'info', message: '构建内存预算池已预占 2048MB（上次峰值 0MB，子进程堆上限 --max-old-space-size=2048）', stage: 'build', timestamp: TS },
    { level: 'info', message: '> app@1.0.0 build /x', stage: 'build', timestamp: TS },
    { level: 'info', message: '> vite build', stage: 'build', timestamp: TS },
    { level: 'warn', message: 'sh: 1: vite: not found', stage: 'build', timestamp: TS },
    { level: 'error', message: '构建产物 执行失败，退出码 127\nsh: 1: vite: not found', stage: 'error', timestamp: TS },
  ];
  const summary = diagnose(logs);
  assert.equal(summary?.category, '命令未安装');
  assert.equal(summary?.violation, 'vite');
  assert.equal(summary?.lineIndex, 7);

  // 构建段没有可识别报错时，只退回汇总正文与退出码，不会去抓安装阶段的 ETIMEDOUT
  const quiet: DeployLogItem[] = [...logs.slice(0, 6), { level: 'error', message: '构建产物 执行失败，退出码 2', stage: 'error', timestamp: TS }];
  const quietSummary = diagnose(quiet);
  assert.equal(quietSummary?.category, '执行失败');
  assert.match(quietSummary!.title, /退出码 2/);
});

test('旧记录：整坨 stderr 汇总消息经去噪后，lineIndex 仍对准 Monaco 展示行', () => {
  const message = `构建产物 执行失败，退出码 1
(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
error during build:
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vite-plugin-svg-icons' imported from ${WS}/vite.config.ts.timestamp-1-ab.mjs`;
  const logs: DeployLogItem[] = [
    { level: 'info', message: 'vite v5.4.10 building for production...', timestamp: TS },
    { level: 'error', message, timestamp: TS },
  ];
  const summary = extractErrorSummaryFromLogs(logs, { status: 'failed' } as any);
  assert.equal(summary?.violation, 'vite-plugin-svg-icons');
  assertLineIndexPointsTo(logs, summary, 'Cannot find package');
});

test('子步骤推断：vue-tsc 自身崩溃算 vue-tsc 失败；vite 没开始时不乱猜失败步骤', () => {
  const crash = diagnose(buildFailureLogs({
    chunks: [
      { out: '\n> app@1.0.0 build /x\n> vue-tsc --noEmit && vite build\n' },
      { err: `TypeError: Cannot read properties of undefined (reading 'flags')\n    at Object.getTypeFlags (${WS}/node_modules/vue-tsc/node_modules/typescript/lib/tsc.js:100:1)\n    at run (${WS}/node_modules/vue-tsc/bin/vue-tsc.js:68:3)` },
    ],
  }));
  assert.equal(crash?.failedStep, 'vue-tsc --noEmit');
  assert.deepEqual(crash?.skippedSteps, ['vite build']);

  const unknown = diagnose(buildFailureLogs({
    chunks: [
      { out: '\n> app@1.0.0 build /x\n> node scripts/gen.mjs && vite build\n' },
      { err: 'Error: something failed' },
    ],
  }));
  assert.equal(unknown?.failedStep, undefined, '无法确定时不写失败步骤');
  assert.equal(unknown?.failedCommand, 'node scripts/gen.mjs && vite build');

  const notFound = diagnose(buildFailureLogs({
    chunks: [{ out: '\n> app@1.0.0 build /x\n> vue-tsc --noEmit && vite build\n' }, { err: 'sh: 1: vue-tsc: not found' }],
  }));
  assert.equal(notFound?.failedStep, 'vue-tsc --noEmit');
});

test('正则安全：各类 2000 字符对抗输入下单行诊断都是毫秒级', () => {
  const units = [' ', 'a', '/', '.', ':', '@', '-', '\\', '"', "'", '[', '(', 'a.', 'a/', '1:', 'at ', '@a/', '||', '>=1 ', 'x@1 '];
  const prefixes = ['', 'Error: ', '> ', 'npm ERR! ', 'at ', '[vite] ', 'file://', 'engines.node ', "Cannot find module '", 'sh: 1: ', '✘ [ERROR] ', 'src/a.ts(', 'requires Node.js version '];
  let worst = 0;
  for (const prefix of prefixes) {
    for (const unit of units) {
      const line = `${prefix}${unit.repeat(Math.ceil(2000 / unit.length))}`.slice(0, 2000) + '!';
      const started = performance.now();
      diagnose([
        { level: 'error', message: line, source: 'tool', stage: 'build', timestamp: TS },
        { level: 'error', message: `构建产物 执行失败，退出码 1\n${line}`, stage: 'error', timestamp: TS },
      ]);
      toRepoRelativePath(line);
      worst = Math.max(worst, performance.now() - started);
    }
  }
  assert.ok(worst < 200, `最慢一次 ${worst.toFixed(1)}ms`);
});

test('路径裁剪：默认数据目录 .yuyan-deploy 与自定义 DEPLOY_DATA_DIR 都能还原为仓库相对路径，非工作区路径原样保留', () => {
  assert.equal(toRepoRelativePath('/opt/yuyan/.yuyan-deploy/cache/workspaces/7/0123456789abcdef/repo/src/App.vue:12:3'), 'src/App.vue:12:3');
  assert.equal(toRepoRelativePath('D:\\yuyan-data\\cache\\workspaces\\7\\0123456789abcdef\\repo\\web\\vite.config.ts.timestamp-1-ab.mjs'), 'web/vite.config.ts');
  assert.equal(toRepoRelativePath('file:///srv/data/cache/workspaces/7/abc/repo/scripts/check.mjs:3'), 'scripts/check.mjs:3');
  assert.equal(toRepoRelativePath('/srv/cache/workspaces/7/repo-old/a.ts'), '/srv/cache/workspaces/7/repo-old/a.ts');
  assert.equal(toRepoRelativePath('/usr/lib/node_modules/npm/index.js'), '/usr/lib/node_modules/npm/index.js');
});
