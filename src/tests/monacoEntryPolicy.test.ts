import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

/**
 * Monaco 拆包守卫（策略测试）：防止重型依赖被重新引入首屏入口。
 * @description 背景：monaco-editor 原始体积约 3MB（gzip ~780KB），
 * 曾在 main.ts 静态引入导致首屏全量下载解析；现已迁移到
 * vite.config.ts 的 virtual:yss-heavy-components 虚拟模块，随首个 Monaco 消费者懒加载。
 */

const readSource = (url: URL) => fs.readFileSync(url, 'utf8');
const mainTs = readSource(new URL('../main.ts', import.meta.url));
const viteConfigTs = readSource(new URL('../../vite.config.ts', import.meta.url));

test('main.ts 不得静态引入 monaco-editor 或其语言支持包', () => {
  assert.ok(
    !/import\s+['"]monaco-editor/.test(mainTs),
    'main.ts 出现 monaco-editor 静态引入，会把 3MB 编辑器打回首屏入口'
  );
  assert.ok(
    !/from\s+['"][^'"]*monaco/.test(mainTs),
    'main.ts 不得从任何 monaco 相关模块导入（包括 configureMonacoJsonHighlight，其内部静态引入 monaco editor.api）'
  );
});

test('main.ts 不得调用 configureMonacoJsonHighlight（会拉入 monaco 依赖链）', () => {
  assert.ok(!mainTs.includes('configureMonacoJsonHighlight'), 'Monaco 高亮注册应随虚拟模块懒加载');
});

test('main.ts 不得静态引入 YSS 重组件入口（仅允许 lite 与样式）', () => {
  assert.ok(
    !/from\s+['"]@yss-ui\/components['"]/.test(mainTs),
    'main.ts 引入了 @yss-ui/components 主入口（含 YMonaco），请改用 @yss-ui/components/lite 或 virtual:yss-heavy-components'
  );
});

test('Monaco 懒加载能力必须保留在 virtual:yss-heavy-components 虚拟模块中', () => {
  assert.ok(viteConfigTs.includes("import 'monaco-editor/esm/vs/language/json/monaco.contribution'"), 'JSON 语言包注册缺失');
  assert.ok(viteConfigTs.includes("import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution'"), 'YAML 语言包注册缺失');
  assert.ok(viteConfigTs.includes('configureMonacoJsonHighlight'), '自定义 JSON 高亮注册缺失');
});
