import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTreeAwareRepositoryReader,
  selectExistingFilePaths,
  type RepositoryTreeEntry,
} from '../repositoryTreeReader.ts';
import { detectDeployApplication } from '../deployRootProjectDetector.ts';

test('selectExistingFilePaths: 按指定顺序筛选真实存在的 blob，排除同名 tree 和缺失文件', () => {
  const entries: RepositoryTreeEntry[] = [
    { name: '.env', type: 'blob' },
    { name: '.env.local', type: 'tree' }, // 同名 tree 忽略
    { name: '.env.production', type: 'blob' },
    { name: 'other.txt', type: 'blob' },
  ];

  // 1. 子目录场景：保持入参顺序且拼接前缀
  const result1 = selectExistingFilePaths('packages/view', entries, [
    '.env.production',
    '.env.local',
    '.env',
    '.env.staging',
  ]);
  assert.deepEqual(result1, [
    'packages/view/.env.production',
    'packages/view/.env',
  ]);

  // 2. 根目录场景（''）：保持入参顺序且不带斜杠前缀
  const result2 = selectExistingFilePaths('', entries, [
    '.env',
    '.env.production',
    '.env.missing',
  ]);
  assert.deepEqual(result2, [
    '.env',
    '.env.production',
  ]);

  // 3. 根目录以 / 开头或带有冗余斜杠时应正确规范化
  const result3 = selectExistingFilePaths('/packages/view/', entries, [
    '.env',
  ]);
  assert.deepEqual(result3, [
    'packages/view/.env',
  ]);
});

test('createTreeAwareRepositoryReader: 不存在的文件不调用 readFile', async () => {
  const readCalls: string[] = [];
  const listCalls: string[] = [];

  const reader = createTreeAwareRepositoryReader({
    listDirectory: async (dir) => {
      listCalls.push(dir);
      if (dir === '') {
        return [
          { name: 'package.json', type: 'blob' },
          { name: 'src', type: 'tree' },
        ];
      }
      return [];
    },
    readFile: async (path) => {
      readCalls.push(path);
      return 'content';
    },
  });

  // 根目录不存在的文件
  const res1 = await reader('.env');
  assert.equal(res1, null);
  assert.equal(readCalls.length, 0);

  // 根目录存在的文件
  const res2 = await reader('package.json');
  assert.equal(res2, 'content');
  assert.deepEqual(readCalls, ['package.json']);
});

test('createTreeAwareRepositoryReader: 不存在的子目录不调用 listDirectory', async () => {
  const listCalls: string[] = [];
  const readCalls: string[] = [];

  const reader = createTreeAwareRepositoryReader({
    listDirectory: async (dir) => {
      listCalls.push(dir);
      if (dir === '') {
        return [
          { name: 'package.json', type: 'blob' },
          { name: 'packages', type: 'tree' },
        ];
      }
      if (dir === 'packages') {
        return [
          { name: 'view', type: 'tree' },
        ];
      }
      if (dir === 'packages/view') {
        return [
          { name: '.env', type: 'blob' },
        ];
      }
      return null;
    },
    readFile: async (path) => {
      readCalls.push(path);
      return path;
    },
  });

  // 读取不存在的顶级目录下的文件：例如 'not_exist/file.txt'
  // 因为根目录列表中没有 'not_exist' (tree)，所以不应对 'not_exist' 发起 listDirectory
  const res1 = await reader('not_exist/file.txt');
  assert.equal(res1, null);
  assert.deepEqual(listCalls, ['']);
  assert.equal(readCalls.length, 0);

  // 读取不存在的二级子目录下的文件：例如 'packages/unknown_sub/file.txt'
  const res2 = await reader('packages/unknown_sub/file.txt');
  assert.equal(res2, null);
  // 只列了 '' 和 'packages'，没有对 'packages/unknown_sub' 发起 listDirectory
  assert.deepEqual(listCalls, ['', 'packages']);
  assert.equal(readCalls.length, 0);
});

test('createTreeAwareRepositoryReader: 每目录只 list 一次即便并发', async () => {
  let listCount = 0;
  const reader = createTreeAwareRepositoryReader({
    listDirectory: async (dir) => {
      listCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (dir === '') {
        return [
          { name: 'a.txt', type: 'blob' },
          { name: 'b.txt', type: 'blob' },
          { name: 'c.txt', type: 'blob' },
        ];
      }
      return null;
    },
    readFile: async (path) => `content:${path}`,
  });

  // 并发读取根目录下的 3 个文件
  const [a, b, c] = await Promise.all([
    reader('a.txt'),
    reader('b.txt'),
    reader('c.txt'),
  ]);

  assert.equal(a, 'content:a.txt');
  assert.equal(b, 'content:b.txt');
  assert.equal(c, 'content:c.txt');
  assert.equal(listCount, 1);
});

test('createTreeAwareRepositoryReader: listDirectory 抛错后可重试', async () => {
  let attempts = 0;
  const reader = createTreeAwareRepositoryReader({
    listDirectory: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('网络超时');
      }
      return [{ name: 'file.txt', type: 'blob' }];
    },
    readFile: async (path) => `ok:${path}`,
  });

  // 第一次调用应当抛错
  await assert.rejects(async () => {
    await reader('file.txt');
  }, /网络超时/);

  // 抛错后缓存应当被清理，重试应当成功
  const res = await reader('file.txt');
  assert.equal(res, 'ok:file.txt');
  assert.equal(attempts, 2);
});

test('端到端测试：内存树 + detectDeployApplication 识别 packages/view/.env.production，断言 readFile 只读真实存在的文件', async () => {
  // 模拟仓库结构：
  // 根目录：
  //   package.json (blob)
  //   packages (tree)
  // packages:
  //   view (tree)
  // packages/view:
  //   .env.production (blob)
  const treeMap: Record<string, RepositoryTreeEntry[]> = {
    '': [
      { name: 'package.json', type: 'blob' },
      { name: 'packages', type: 'tree' },
    ],
    packages: [
      { name: 'view', type: 'tree' },
    ],
    'packages/view': [
      { name: '.env.production', type: 'blob' },
    ],
  };

  const filesMap: Record<string, string> = {
    'package.json': JSON.stringify({
      scripts: {
        build: 'cd packages/view && vite build --mode production',
      },
    }),
    'packages/view/.env.production': 'VITE_SUB_APP_NAME = order-center # 订单微应用',
  };

  const readPaths: string[] = [];

  const reader = createTreeAwareRepositoryReader({
    listDirectory: async (dir) => treeMap[dir] || null,
    readFile: async (path) => {
      readPaths.push(path);
      return filesMap[path] ?? null;
    },
  });

  const detection = await detectDeployApplication({
    buildCommand: 'npm run build',
    readFile: reader,
  });

  assert.equal(detection.status, 'resolved');
  assert.equal(detection.kind, 'micro');
  assert.equal(detection.appName, 'order-center');
  assert.equal(detection.sourcePath, 'packages/view/.env.production');

  // 断言 readFile 只被调用于真实存在的文件，绝对没有对不存在的 .env、.env.local、.env.production.local 调用 readFile
  assert.deepEqual(readPaths, ['package.json', 'packages/view/.env.production']);
});
