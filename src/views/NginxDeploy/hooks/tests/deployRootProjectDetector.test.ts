import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectDeployApplication,
  parseViteMode,
  parseViteSubAppName,
  parseVue2AppIds,
  type RepositoryFileReader,
} from '../deployRootProjectDetector.ts';

/**
 * 从内存文件表创建仓库读取函数。
 * @param files 仓库文件表
 * @returns 文件读取函数
 */
const createReader = (files: Record<string, string>): RepositoryFileReader => async (filePath) => files[filePath] ?? null;

test('解析 Vite mode 与带空格、引号的微应用变量', () => {
  assert.equal(parseViteMode('vite build'), 'production');
  assert.equal(parseViteMode('vite build --mode production.jsp-theme'), 'production.jsp-theme');
  assert.equal(parseViteMode('vite build --mode=production.standalone'), 'production.standalone');
  assert.equal(parseViteSubAppName('VITE_SUB_APP_NAME = metaData\n'), 'metaData');
  assert.equal(parseViteSubAppName('export VITE_SUB_APP_NAME="insurance-risk" # ignored\n'), 'insurance-risk');
});

test('Vue2 标识解析不依赖属性顺序或引号类型', () => {
  assert.deepEqual(
    parseVue2AppIds(`
      <div class='page yss-main-app' data-x="1" id='dmJurisdictionBuilder'></div>
      <main id="fileManagement" class="yss-main-app"></main>
      <!-- <div id="commentedApp" class="yss-main-app"></div> -->
      <div id="ignored" class="other"></div>
    `),
    ['dmJurisdictionBuilder', 'fileManagement']
  );
});

test('Vite 高优先级环境文件可覆盖或显式清空低优先级标识', async () => {
  const overridden = await detectDeployApplication({
    buildCommand: 'vite build --mode qa',
    readFile: createReader({
      '.env': 'VITE_SUB_APP_NAME=base-app',
      '.env.qa': 'VITE_SUB_APP_NAME=qa-app',
    }),
  });
  const cleared = await detectDeployApplication({
    buildCommand: 'vite build --mode qa',
    readFile: createReader({
      '.env': 'VITE_SUB_APP_NAME=base-app',
      '.env.qa.local': 'VITE_SUB_APP_NAME =',
    }),
  });

  assert.equal(overridden.appName, 'qa-app');
  assert.equal(cleared.status, 'unresolved');
});

test('Vue3 多层 package scripts 按 production mode 识别微应用', async () => {
  const result = await detectDeployApplication({
    buildCommand: 'pnpm build',
    artifactDir: 'packages/dist',
    projectName: 'yss-valuation-outsourced',
    readFile: createReader({
      'package.json': JSON.stringify({ scripts: { build: 'cd packages && pnpm build' } }),
      'packages/package.json': JSON.stringify({ scripts: { build: 'vite build' } }),
      'packages/.env.development': 'VITE_SUB_APP_NAME=dev-outsourced',
      'packages/.env.production': 'VITE_SUB_APP_NAME = outsourced',
    }),
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.kind, 'micro');
  assert.equal(result.appName, 'outsourced');
  assert.equal(result.mode, 'production');
  assert.equal(result.sourcePath, 'packages/.env.production');
});

test('Vue3 standalone 脚本始终识别为主应用', async () => {
  const result = await detectDeployApplication({
    buildCommand: 'pnpm build:standalone',
    readFile: createReader({
      'package.json': JSON.stringify({ scripts: { 'build:standalone': 'cd packages && pnpm build:standalone' } }),
      'packages/package.json': JSON.stringify({ scripts: { 'build:standalone': 'vite build --mode production.standalone' } }),
      'packages/.env.production.standalone': 'VITE_SUB_APP_NAME=quality-v3',
    }),
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.kind, 'main');
  assert.equal(result.mode, 'production.standalone');
});

test('Vue2 微应用与 yssMainApp 门户按约定区分', async () => {
  const baseFiles = {
    'package.json': JSON.stringify({ scripts: { 'build:view': 'cd packages/view && yarn build' } }),
    'packages/view/package.json': JSON.stringify({ scripts: { build: 'vue-cli-service build' } }),
  };
  const micro = await detectDeployApplication({
    buildCommand: 'yarn build:view',
    artifactDir: 'packages/view/dist',
    readFile: createReader({
      ...baseFiles,
      'packages/view/public/index.html': '<div id="dmJurisdictionBuilder" class="yss-main-app"></div>',
    }),
  });
  const main = await detectDeployApplication({
    buildCommand: 'yarn build:view',
    artifactDir: 'packages/view/dist',
    readFile: createReader({
      ...baseFiles,
      'packages/view/public/index.html': "<div class='yss-main-app' id='yssMainApp'></div>",
    }),
  });

  assert.deepEqual({ status: micro.status, kind: micro.kind, appName: micro.appName }, { status: 'resolved', kind: 'micro', appName: 'dmJurisdictionBuilder' });
  assert.deepEqual({ status: main.status, kind: main.kind }, { status: 'resolved', kind: 'main' });
});

test('Vue2 Lerna 根构建可回退检查标准 view 工作区', async () => {
  const result = await detectDeployApplication({
    buildCommand: 'yarn build',
    readFile: createReader({
      'package.json': JSON.stringify({ scripts: { build: 'lerna run --stream --sort build' } }),
      'packages/view/package.json': JSON.stringify({ scripts: { build: 'vue-cli-service build' } }),
      'packages/view/public/index.html': '<div id="fileManagement" class="yss-main-app"></div>',
    }),
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.appName, 'fileManagement');
});

test('多个冲突标识或缺少标识时不使用项目名猜测', async () => {
  const conflict = await detectDeployApplication({
    buildCommand: 'lerna run --stream --sort build',
    readFile: createReader({
      '.env.production': 'VITE_SUB_APP_NAME=alpha',
      'packages/.env.production': 'VITE_SUB_APP_NAME=beta',
    }),
  });
  const missing = await detectDeployApplication({
    buildCommand: 'pnpm build',
    projectName: 'some-project',
    readFile: createReader({}),
  });

  assert.equal(conflict.status, 'unresolved');
  assert.match(conflict.reason, /多个/);
  assert.equal(missing.status, 'unresolved');
  assert.equal(missing.appName, undefined);
});

test('构建命令包含命令替换或管道时拒绝继续猜测', async () => {
  const commandSubstitution = await detectDeployApplication({
    buildCommand: 'cd $(pwd) && vite build',
    readFile: createReader({ '.env.production': 'VITE_SUB_APP_NAME=unsafe' }),
  });
  const pipeline = await detectDeployApplication({
    buildCommand: 'vite build | tee build.log',
    readFile: createReader({ '.env.production': 'VITE_SUB_APP_NAME=unsafe' }),
  });

  assert.equal(commandSubstitution.status, 'unresolved');
  assert.match(commandSubstitution.reason, /安全解析/);
  assert.equal(pipeline.status, 'unresolved');
});

test('项目名称或描述明确标注主应用时直接选择根目录', async () => {
  const result = await detectDeployApplication({
    buildCommand: 'vite build',
    projectDescription: 'Vue3 门户主应用',
    readFile: createReader({}),
  });

  assert.equal(result.status, 'resolved');
  assert.equal(result.kind, 'main');
});
