import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getEntryOccupant,
  isPathWithinAnyRoot,
  isSubPathOrEqual,
  normalizePosix,
} from '../constant.ts';
import {
  extractOccupiedMap,
  resolveLockedScope,
} from '../../DeployTargetConfigModal/components/DeployRootField/constant.ts';

test('isSubPathOrEqual: 正确识别受限根与子路径边界', () => {
  const root = '/opt/yuyan/html';

  // 精准命中允许根自身
  assert.equal(isSubPathOrEqual('/opt/yuyan/html', root), true);
  assert.equal(isSubPathOrEqual('/opt/yuyan/html/', root), true);

  // 命中合法深层子目录
  assert.equal(isSubPathOrEqual('/opt/yuyan/html/outsourced', root), true);
  assert.equal(isSubPathOrEqual('/opt/yuyan/html/system/dist', root), true);

  // 阻断受限根之上的祖先路径（面包屑上级段），防止 403
  assert.equal(isSubPathOrEqual('/opt/yuyan', root), false);
  assert.equal(isSubPathOrEqual('/opt', root), false);
  assert.equal(isSubPathOrEqual('/', root), false);

  // 阻断非法平级同前缀逃逸路径
  assert.equal(isSubPathOrEqual('/opt/yuyan/html-escape', root), false);
  assert.equal(isSubPathOrEqual('/etc/nginx', root), false);
});

test('isPathWithinAnyRoot: 支持多受限作用域根联合判定', () => {
  const roots = [
    { path: '/opt/yuyan/html' },
    { path: '/etc/nginx/conf.d' },
  ];

  assert.equal(isPathWithinAnyRoot('/opt/yuyan/html/taskFlow', roots), true);
  assert.equal(isPathWithinAnyRoot('/etc/nginx/conf.d/vhost.conf', roots), true);

  // 任何在所有根之外的路径一律判定不可访问
  assert.equal(isPathWithinAnyRoot('/opt/yuyan', roots), false);
  assert.equal(isPathWithinAnyRoot('/etc/nginx', roots), false);
  assert.equal(isPathWithinAnyRoot('/var/log', roots), false);
});

test('normalizePosix: 规范化各种反斜杠与冗余斜杠路径', () => {
  assert.equal(normalizePosix('//opt//yuyan///html/'), '/opt/yuyan/html');
  assert.equal(normalizePosix('\\opt\\yuyan\\html'), '/opt/yuyan/html');
  assert.equal(normalizePosix(''), '/');
});

test('隐藏条目过滤规则: 仅保留业务目录和虚拟上一级，默认隐藏点开头项', () => {
  const mockEntries = [
    { name: '..', type: 'parent_dir' },
    { name: '.vite', type: 'directory' },
    { name: '.yuyan-backups', type: 'directory' },
    { name: '.yuyan-manifests', type: 'directory' },
    { name: 'outsourced', type: 'directory' },
    { name: 'system', type: 'directory' },
    { name: 'taskFlow', type: 'directory' },
  ];

  // 默认过滤 (showHidden = false)
  const filtered = mockEntries.filter((item) => {
    if (item.type === 'parent_dir') return true;
    if (item.type !== 'directory') return false;
    return !item.name.startsWith('.');
  });

  assert.deepEqual(
    filtered.map((e) => e.name),
    ['..', 'outsourced', 'system', 'taskFlow']
  );

  // 开启显示隐藏项 (showHidden = true)
  const allDirs = mockEntries.filter((item) => item.type === 'parent_dir' || item.type === 'directory');
  assert.equal(allDirs.length, 7);
});

test('getEntryOccupant: 正确匹配已占用目录说明', () => {
  const map = {
    '/opt/yuyan/html/outsourced': '已由 yss-valuation-outsourced 占用',
  };

  assert.equal(
    getEntryOccupant('/opt/yuyan/html/outsourced', map),
    '已由 yss-valuation-outsourced 占用'
  );
  assert.equal(
    getEntryOccupant('/opt/yuyan/html/outsourced/', map),
    '已由 yss-valuation-outsourced 占用'
  );
  assert.equal(getEntryOccupant('/opt/yuyan/html/other', map), undefined);
});

test('resolveLockedScope: 针对不同项目类型与 Nginx 实例锁定基准根并开放至父级', () => {
  const fakeServer = {
    id: 1,
    defaultDeployRoot: '/opt/default/html',
    defaultBackendRoot: '/opt/yuyan/services',
    nginxInstances: [
      { id: 10, name: 'yuyan托管', htmlRoot: '/opt/yuyan/html', defaultDeployRoot: '/opt/yuyan' },
      { id: 20, name: '已有Nginx', htmlRoot: '/home/app/frontend/html' },
      { id: 30, name: '外部已有Nginx', defaultDeployRoot: '/home/app/frontend/html' },
    ],
  };

  // 前端项目：托管 Nginx 实例，基准根开放到 /opt/yuyan，默认打开 /opt/yuyan/html
  const frontScope10 = resolveLockedScope(fakeServer as any, 'frontend', 10);
  assert.equal(frontScope10.root, '/opt/yuyan');
  assert.equal(frontScope10.defaultPath, '/opt/yuyan/html');
  assert.equal(frontScope10.label, 'Nginx: yuyan托管');

  // 前端项目：已有 Nginx 实例（配置 htmlRoot），基准根向上开放至父级 /home/app/frontend，默认打开 /home/app/frontend/html
  const frontScope20 = resolveLockedScope(fakeServer as any, 'frontend', 20);
  assert.equal(frontScope20.root, '/home/app/frontend');
  assert.equal(frontScope20.defaultPath, '/home/app/frontend/html');
  assert.equal(frontScope20.label, 'Nginx: 已有Nginx');

  // 前端项目：已有 Nginx 实例（仅配置 defaultDeployRoot 无 htmlRoot），基准根亦能精准向上开放至父级 /home/app/frontend
  const frontScope30 = resolveLockedScope(fakeServer as any, 'frontend', 30);
  assert.equal(frontScope30.root, '/home/app/frontend');
  assert.equal(frontScope30.defaultPath, '/home/app/frontend/html');
  assert.equal(frontScope30.label, 'Nginx: 外部已有Nginx');

  // 后端项目：锁定在后端服务根
  const backScope = resolveLockedScope(fakeServer as any, 'backend');
  assert.equal(backScope.root, '/opt/yuyan/services');
  assert.equal(backScope.defaultPath, '/opt/yuyan/services');
  assert.equal(backScope.label, '后端服务根');
});

test('extractOccupiedMap: 从推荐候选中提取被占用的目录与说明', () => {
  const options = [
    { value: '/opt/yuyan/html/outsourced', description: '已由 yss-valuation-outsourced 占用', section: '占用', disabled: true },
    { value: '/opt/yuyan/html/ai-center', description: '推荐新目录', section: '推荐', disabled: false },
  ];

  const map = extractOccupiedMap(options);
  assert.equal(map['/opt/yuyan/html/outsourced'], '已由 yss-valuation-outsourced 占用');
  assert.equal(map['/opt/yuyan/html/ai-center'], undefined);
});
