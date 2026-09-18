import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPathWithinRoots,
  formatPosixPermissions,
  isBinaryBuffer,
  normalizePosixPath,
  resolveServerAllowedRoots,
} from '../remote-fs-service.mjs';

test('normalizePosixPath 能正确标准化路径并处理边界情况', () => {
  assert.equal(normalizePosixPath('/data/web/html/'), '/data/web/html');
  assert.equal(normalizePosixPath('data\\web\\html'), '/data/web/html');
  assert.equal(normalizePosixPath('/data/web/../html'), '/data/html');
  assert.equal(normalizePosixPath(''), '/');
  assert.equal(normalizePosixPath('/'), '/');
  assert.equal(normalizePosixPath('///'), '/');
});

test('formatPosixPermissions 正确格式化权限掩码', () => {
  assert.equal(formatPosixPermissions(0o755), 'rwxr-xr-x');
  assert.equal(formatPosixPermissions(0o644), 'rw-r--r--');
  assert.equal(formatPosixPermissions(0o700), 'rwx------');
  assert.equal(formatPosixPermissions(null), '---------');
});

test('isBinaryBuffer 能检测空字节二进制内容', () => {
  assert.equal(isBinaryBuffer(Buffer.from('Hello World!')), false);
  assert.equal(isBinaryBuffer(Buffer.from('<div>HTML Text</div>')), false);
  assert.equal(isBinaryBuffer(Buffer.from([0x68, 0x65, 0x00, 0x6c, 0x6f])), true);
});

test('resolveServerAllowedRoots 从服务器和部署目标动态推导允许根', () => {
  const fakeServer = {
    id: 1,
    defaultDeployRoot: '/data/web/html',
    defaultBackendRoot: '/opt/apps/backend',
    nginxInstances: [
      { id: 10, name: '主站 Nginx', htmlRoot: '/var/www/site1', configPath: '/etc/nginx/conf.d/site1.conf' },
    ],
  };
  const fakeTargets = [
    { id: 101, serverId: 1, projectName: '测试项目 A', deployRoot: '/data/web/html/sub-project-a' },
    { id: 102, serverId: 2, projectName: '其他机器项目', deployRoot: '/data/other/ignore' },
  ];

  const roots = resolveServerAllowedRoots(fakeServer, fakeTargets);

  assert.equal(roots.length, 5);
  assert.equal(roots[0].path, '/data/web/html');
  assert.equal(roots[0].isDefault, true);

  const paths = roots.map((r) => r.path);
  assert.ok(paths.includes('/var/www/site1'));
  assert.ok(paths.includes('/etc/nginx/conf.d'));
  assert.ok(paths.includes('/opt/apps/backend'));
  assert.ok(paths.includes('/data/web/html/sub-project-a'));
  assert.ok(!paths.includes('/data/other/ignore'));
});

test('resolveServerAllowedRoots 拦截范围过宽的根目录（少于两级）', () => {
  const fakeServer = {
    id: 1,
    defaultDeployRoot: '/',
    nginxInstances: [{ id: 1, htmlRoot: '/opt' }],
  };
  assert.throws(() => resolveServerAllowedRoots(fakeServer, []), /未配置任何前端或 Nginx 作用域根目录/);
});

test('assertPathWithinRoots 允许合法子路径与精准命中', () => {
  const allowedRoots = [
    { id: 'site', label: '站点根', path: '/data/web/html' },
    { id: 'conf', label: '配置目录', path: '/etc/nginx/conf.d' },
  ];

  // 精准命中
  assert.equal(assertPathWithinRoots('/data/web/html', allowedRoots), '/data/web/html');
  assert.equal(assertPathWithinRoots('/data/web/html/', allowedRoots), '/data/web/html');

  // 子目录命中
  assert.equal(assertPathWithinRoots('/data/web/html/assets/css', allowedRoots), '/data/web/html');
  assert.equal(assertPathWithinRoots('/etc/nginx/conf.d/default.conf', allowedRoots), '/etc/nginx/conf.d');
});

test('assertPathWithinRoots 严密拦截越权与逃逸路径', () => {
  const allowedRoots = [
    { id: 'site', label: '站点根', path: '/data/web/html' },
  ];

  // 1. 同名前缀逃逸（例如 /data/web/html-leak 不应该被 /data/web/html 匹配）
  assert.throws(() => assertPathWithinRoots('/data/web/html-leak', allowedRoots), /超出服务器允许的访问范围/);

  // 2. 相对路径逃逸 ..
  assert.throws(() => assertPathWithinRoots('/data/web/html/../../etc/passwd', allowedRoots), /超出服务器允许的访问范围/);

  // 3. 根目录越权
  assert.throws(() => assertPathWithinRoots('/', allowedRoots), /超出服务器允许的访问范围/);
  assert.throws(() => assertPathWithinRoots('/etc', allowedRoots), /超出服务器允许的访问范围/);
  assert.throws(() => assertPathWithinRoots('/root', allowedRoots), /超出服务器允许的访问范围/);
});
