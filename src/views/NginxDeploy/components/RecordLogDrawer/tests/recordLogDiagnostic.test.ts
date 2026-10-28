import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractErrorSummaryFromLogs,
  cleanLogMessage,
  formatEditorDiagnosticBanner,
} from '../constant.ts';
import type { DeployLogItem } from '@/api/deploy';

test('extractErrorSummaryFromLogs: 提取图一中的 @vue-office/excel 依赖解析失败', () => {
  const logs: DeployLogItem[] = [
    { level: 'info', message: 'vite v6.0.5 building for production...', timestamp: '2026-10-22 14:00:00' },
    { level: 'warn', message: '<script src="/locale-reload.js"> in "/index.html" can\'t be bundled without type="module"', timestamp: '2026-10-22 14:00:01' },
    { level: 'info', message: '46 modules transformed.', timestamp: '2026-10-22 14:00:01' },
    { level: 'error', message: 'x Build failed in 262ms', timestamp: '2026-10-22 14:00:01' },
    { level: 'error', message: 'error during build:', timestamp: '2026-10-22 14:00:01' },
    {
      level: 'error',
      message: '[commonjs--resolver] Failed to resolve entry for package "@vue-office/excel". The package may have incorrect main/module/exports specified in its package.json.',
      timestamp: '2026-10-22 14:00:01',
    },
    { level: 'info', message: 'ELIFECYCLE Command failed with exit code 1.', timestamp: '2026-10-22 14:00:02' },
  ];

  const summary = extractErrorSummaryFromLogs(logs, { status: 'failed' } as any);
  assert.ok(summary);
  assert.equal(summary?.category, '依赖解析失败');
  assert.equal(summary?.title, '未能正确解析依赖包入口');
  assert.equal(summary?.violation, '@vue-office/excel');
  assert.equal(summary?.lineIndex, 6);
  assert.ok(summary?.suggestion?.includes('@vue-office/excel'));
});

test('extractErrorSummaryFromLogs: 提取图二中的 check-build-bundle 首屏重型依赖拦截', () => {
  const logs: DeployLogItem[] = [
    { level: 'info', message: '✓ built in 1m 19s', timestamp: '2026-10-22 14:20:33' },
    { level: 'warn', message: '(!) Some chunks are larger than 500 kB after minification.', timestamp: '2026-10-22 14:20:33' },
    { level: 'info', message: '[precompress] 144 个文件，生成 234 个静态压缩文件', timestamp: '2026-10-22 14:20:35' },
    { level: 'warn', message: 'file:///data/yuyan-ops/scripts/check-build-bundle.mjs:285', timestamp: '2026-10-22 14:20:35' },
    { level: 'warn', message: "throw new Error('首屏静态依赖包含重型运行时依赖: ${violations.join(\", \")}');", timestamp: '2026-10-22 14:20:35' },
    { level: 'warn', message: '^', timestamp: '2026-10-22 14:20:35' },
    { level: 'warn', message: 'Error: 首屏静态依赖包含重型运行时依赖: assets/index-3D8Dk8ub.js', timestamp: '2026-10-22 14:20:35' },
    { level: 'warn', message: 'at checkHeavyRuntime (file:///data/yuyan-ops/scripts/check-build-bundle.mjs:285:11)', timestamp: '2026-10-22 14:20:35' },
    { level: 'info', message: 'ELIFECYCLE Command failed with exit code 1.', timestamp: '2026-10-22 14:20:35' },
    { level: 'error', message: '构建产物 执行失败，退出码 1', timestamp: '2026-10-22 14:20:35' },
    { level: 'info', message: '<script src="/locale.js"> can\'t be bundled', timestamp: '2026-10-22 14:20:35' },
  ];

  const summary = extractErrorSummaryFromLogs(logs, { status: 'failed' } as any);
  assert.ok(summary);
  assert.equal(summary?.category, '工程门禁拦截');
  assert.equal(summary?.title, '首屏静态依赖包含重型运行时依赖');
  assert.equal(summary?.violation, 'assets/index-3D8Dk8ub.js');
  assert.equal(summary?.lineIndex, 7);
  assert.ok(summary?.fileLocation?.includes('check-build-bundle.mjs:285'));
  assert.ok(summary?.suggestion?.includes('按需'));
});

test('extractErrorSummaryFromLogs: 兼容旧历史日志中整坨 stderr 堆叠场景', () => {
  const oldRawMessage = `构建产物 执行失败，退出码 1
<script src="/entrusted-management/locale-reload.js"> in "/index.html" can't be bundled without type="module" attribute

(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
file:///data/yuyan-ops/deploy-data/cache/workspaces/34/ef260e9aa3c673af/repo/scripts/check-build-bundle.mjs:286
    throw new Error(\`首屏静态依赖包含重型运行时依赖：\${violations.join(', ')}\`);
          ^

Error: 首屏静态依赖包含重型运行时依赖：assets/index-BZ-ai3hJ.js
    at checkHeavyRuntime (file:///data/yuyan-ops/deploy-data/cache/workspaces/34/ef260e9aa3c673af/repo/scripts/check-build-bundle.mjs:286:11)`;

  const logs: DeployLogItem[] = [
    { level: 'info', message: 'ELIFECYCLE Command failed with exit code 1.', timestamp: '2026-10-22 15:54:55' },
    { level: 'error', message: oldRawMessage, timestamp: '2026-10-22 15:54:55' },
  ];

  // 1. 验证诊断提炼
  const summary = extractErrorSummaryFromLogs(logs, { status: 'failed' } as any);
  assert.ok(summary);
  assert.equal(summary?.category, '工程门禁拦截');
  assert.equal(summary?.title, '首屏静态依赖包含重型运行时依赖');
  assert.equal(summary?.violation, 'assets/index-BZ-ai3hJ.js');
  assert.equal(summary?.fileLocation, 'scripts/check-build-bundle.mjs:286');

  // 2. 验证日志消息清洗（去除旧噪音，保留真实报错）
  const cleaned = cleanLogMessage(oldRawMessage);
  assert.ok(!cleaned.includes('<script src'));
  assert.ok(!cleaned.includes('Some chunks are larger'));
  assert.ok(cleaned.includes('Error: 首屏静态依赖包含重型运行时依赖：assets/index-BZ-ai3hJ.js'));

  // 3. 验证终端诊断报告生成（全行顶格不带前导空格，避免触发 Monaco 缩进参考竖线）
  const banner = formatEditorDiagnosticBanner(summary!);
  assert.ok(banner.includes('雨燕构建未通过诊断报告'));
  assert.ok(banner.includes('[ERROR] 触发违规: assets/index-BZ-ai3hJ.js'));
  assert.ok(banner.includes('[INFO]  相关位置: scripts/check-build-bundle.mjs:286'));
  assert.ok(banner.includes('💡 排查与修复建议:'));
  for (const bannerLine of banner.split('\n').filter(Boolean)) {
    assert.equal(bannerLine, bannerLine.trimStart(), `诊断横幅行不应存在前导缩进空格: "${bannerLine}"`);
  }
});

test('cleanLogMessage: 过滤 Rollup "use client" 打包期忽略警告并保留 OOM 核心堆栈', () => {
  const oomErrorMessage = `构建产物 执行失败，退出码 null
../node_modules/.pnpm/@radix-ui+react-direction@1.1.4_react@18.3.1/node_modules/@radix-ui/react-direction/dist/index.mjs (1:0): Module level directives cause errors when bundled, "use client" in "../node_modules/.pnpm/@radix-ui+react-direction@1.1.4_react@18.3.1/node_modules/@radix-ui/react-direction/dist/index.mjs" was ignored.
<--- Last few GCs --->
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`;

  const cleaned = cleanLogMessage(oomErrorMessage);
  assert.ok(!cleaned.includes('Module level directives cause errors when bundled'));
  assert.ok(cleaned.includes('FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory'));
});

test('cleanLogMessage: 兼容历史记录中的 ANSI 颜色控制码', () => {
  const raw = '\u001b[36mvite v6.0.5 \u001b[32mbuilding for production...\u001b[36m\u001b[39m';
  assert.equal(cleanLogMessage(raw), 'vite v6.0.5 building for production...');
});
