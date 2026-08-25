import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decorateDeployRootOptions,
  listDeployRootOptions,
  resolveDeployRootTemplate,
  resolveServerDeployRoot,
} from '../deploy-root-options-service.mjs';

test('部署根目录支持固定路径和 appName 模板', () => {
  assert.equal(resolveDeployRootTemplate('/opt/yuyan/html'), '/opt/yuyan/html');
  assert.equal(resolveDeployRootTemplate('/data/webapps/{appName}'), '/data/webapps');
  assert.throws(() => resolveDeployRootTemplate('/'), /范围过宽/);
  assert.throws(() => resolveDeployRootTemplate('/opt'), /范围过宽/);
  assert.throws(() => resolveDeployRootTemplate('relative/path'), /绝对路径/);
  assert.throws(() => resolveDeployRootTemplate('/data/{appName}/dist'), /最后一级/);
});

test('目录服务只使用服务器配置根目录并透传扫描限制', async () => {
  const calls = { scanRoot: '', scanOptions: null, targetQuery: null };
  const result = await listDeployRootOptions(7, { nginxInstanceId: 3, excludeTargetId: 21 }, {
    getServer: async () => ({
      id: 7,
      defaultDeployRoot: '/fallback/root',
      nginxInstances: [{ id: 3, instanceType: 'managed', htmlRoot: '/opt/yuyan/html' }],
    }),
    getTargets: async (query) => {
      calls.targetQuery = query;
      return [{ id: 21, deployRoot: '/opt/yuyan/html/current-app', projectName: '当前应用' }];
    },
    withConnection: async (_server, task) => task({ fake: true }),
    scanDirectories: async (_conn, root, options) => {
      calls.scanRoot = root;
      calls.scanOptions = options;
      return { rootHasIndex: true, truncated: false, directories: [] };
    },
  });

  assert.equal(calls.scanRoot, '/opt/yuyan/html');
  assert.deepEqual(calls.scanOptions, { limit: 200, timeoutMs: 8_000, concurrency: 8 });
  assert.deepEqual(calls.targetQuery, { serverId: 7, projectType: 'frontend' });
  assert.equal(result.items.find((item) => item.path.endsWith('/current-app')).occupied, false);
});

test('SSH 扫描失败时服务返回错误，不伪造服务器目录', async () => {
  await assert.rejects(
    () => listDeployRootOptions(7, {}, {
      getServer: async () => ({ id: 7, defaultDeployRoot: '/opt/yuyan/html', nginxInstances: [] }),
      getTargets: async () => [],
      withConnection: async () => {
        throw new Error('SSH 凭据无效');
      },
    }),
    /SSH 凭据无效/
  );
});

test('托管实例优先使用 htmlRoot，外部实例使用默认模板', () => {
  const server = {
    defaultDeployRoot: '/fallback/root',
    defaultNginxInstanceId: 2,
    nginxInstances: [
      { id: 1, instanceType: 'managed', htmlRoot: '/opt/yuyan/html', defaultDeployRoot: '/ignored/root' },
      { id: 2, instanceType: 'external', defaultDeployRoot: '/data/webapps/{appName}' },
    ],
  };

  assert.deepEqual(resolveServerDeployRoot(server, 1), { configuredRoot: '/opt/yuyan/html', nginxInstanceId: 1 });
  assert.deepEqual(resolveServerDeployRoot(server, 2), { configuredRoot: '/data/webapps', nginxInstanceId: 2 });
  assert.throws(() => resolveServerDeployRoot(server, 99), /不属于当前服务器/);
  assert.throws(() => resolveServerDeployRoot({ nginxInstances: [] }), /未配置前端部署根目录/);
});

test('目录候选附加占用信息并在编辑时排除当前目标', () => {
  const targets = [
    { id: 11, deployRoot: '/opt/yuyan/html/outsourced', projectName: '委外', defaultBranch: 'dev', envName: '测试' },
    { id: 12, deployRoot: '/opt/yuyan/html', projectName: '门户', defaultBranch: 'main', envName: '测试' },
    { id: 13, deployRoot: '/opt/yuyan/html/removed-app', projectName: '历史应用', defaultBranch: 'release', envName: '测试' },
  ];
  const scanResult = {
    rootHasIndex: true,
    truncated: false,
    directories: [
      { name: 'dmJurisdictionBuilder', path: '/opt/yuyan/html/dmJurisdictionBuilder' },
      { name: 'outsourced', path: '/opt/yuyan/html/outsourced' },
    ],
  };
  const createOptions = decorateDeployRootOptions('/opt/yuyan/html', scanResult, targets);
  const editOptions = decorateDeployRootOptions('/opt/yuyan/html', scanResult, targets, 11);

  assert.equal(createOptions.items.find((item) => item.path.endsWith('/outsourced')).occupied, true);
  assert.deepEqual(createOptions.items.find((item) => item.path.endsWith('/outsourced')).occupiedBy[0], {
    targetId: 11,
    projectName: '委外',
    branch: 'dev',
    envName: '测试',
  });
  assert.equal(createOptions.items.find((item) => item.kind === 'root').occupied, true);
  assert.equal(editOptions.items.find((item) => item.path.endsWith('/outsourced')).occupied, false);
  assert.deepEqual(
    createOptions.items.find((item) => item.path.endsWith('/removed-app')),
    {
      kind: 'application',
      name: 'removed-app',
      path: '/opt/yuyan/html/removed-app',
      exists: false,
      hasIndexHtml: false,
      occupied: true,
      occupiedBy: [{ targetId: 13, projectName: '历史应用', branch: 'release', envName: '测试' }],
    }
  );

  const editMissingOption = decorateDeployRootOptions('/opt/yuyan/html', scanResult, targets, 13)
    .items.find((item) => item.path.endsWith('/removed-app'));
  assert.equal(editMissingOption.occupied, false);
  assert.equal(editMissingOption.exists, false);
});

test('接口候选总数最多 200 项且优先保留根目录和已配置路径', () => {
  const directories = Array.from({ length: 205 }, (_, index) => ({
    name: `app-${index}`,
    path: `/opt/yuyan/html/app-${index}`,
  }));
  const result = decorateDeployRootOptions(
    '/opt/yuyan/html',
    { rootHasIndex: true, truncated: false, directories },
    [{ id: 9, deployRoot: '/opt/yuyan/html/removed-app', projectName: '已配置应用' }]
  );

  assert.equal(result.items.length, 200);
  assert.equal(result.truncated, true);
  assert.equal(result.items[0].kind, 'root');
  assert.equal(result.items.some((item) => item.path.endsWith('/removed-app')), true);
});
