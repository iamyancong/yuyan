import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNginxAccessEndpoints,
  dedupeNginxDiagnostics,
  discoverServerNginx,
  parseNginxDiscoverySites,
  parseNginxDiscoveryListen,
  parseNginxDumpSections,
  parseNginxMasterProcesses,
  parseNginxProcPaths,
  parseNginxVersionOutput,
  resolveNginxProcessBinary,
  splitShellWords,
} from '../nginx-discovery-service.mjs';

/** Nginx -T 多文件输出样本。 */
const NGINX_DUMP = `
nginx: the configuration file /home/nginx/conf/nginx.conf syntax is ok
# configuration file /home/nginx/conf/nginx.conf:
http {
  root /home/nginx/default-html;
  include conf.d/*.conf;
}
# configuration file /home/nginx/conf/conf.d/apps.conf:
server {
  listen 127.0.0.1:32088 ssl;
  server_name portal.example.com _;
  root /opt/yuyan/html;
  location /api/ { proxy_pass http://127.0.0.1:8080; }
}
server {
  listen 9000;
  server_name files.example.com;
  location /download/ { alias /home/files/; }
}
server {
  listen 9100;
  server_name dynamic.example.com;
  root /srv/$host;
}
`;

test('shell 参数解析保留引号中的 prefix 和 config 路径', () => {
  assert.deepEqual(
    splitShellWords("/home/nginx/sbin/nginx -p '/home/nginx runtime' -c conf/nginx.conf"),
    ['/home/nginx/sbin/nginx', '-p', '/home/nginx runtime', '-c', 'conf/nginx.conf']
  );
});

test('解析多个 Nginx master 进程及其启动配置', () => {
  const processes = parseNginxMasterProcesses(`
  101 root nginx: master process /home/nginx/sbin/nginx -p /home/nginx -c conf/nginx.conf
  202 app nginx: worker process
  303 root nginx: master process /opt/openresty/nginx/sbin/nginx -c /opt/openresty/nginx/conf/nginx.conf
  `);
  assert.equal(processes.length, 2);
  assert.deepEqual(processes[0], {
    pid: 101,
    user: 'root',
    binary: '/home/nginx/sbin/nginx',
    prefix: '/home/nginx',
    configPath: 'conf/nginx.conf',
    command: '/home/nginx/sbin/nginx -p /home/nginx -c conf/nginx.conf',
  });
});

test('兼容不支持 GNU -o 格式服务器的 ps -ef 输出', () => {
  const processes = parseNginxMasterProcesses(`
root       436     1  0 Jul07 ? 00:00:00 nginx: master process /opt/yuyan/nginx/sbin/nginx -p /opt/yuyan/nginx/ -c /opt/yuyan/nginx/conf/nginx.conf
nobody   26392   436  0 Aug24 ? 00:00:42 nginx: worker process
  `);
  assert.deepEqual(processes, [{
    pid: 436,
    user: 'root',
    binary: '/opt/yuyan/nginx/sbin/nginx',
    prefix: '/opt/yuyan/nginx/',
    configPath: '/opt/yuyan/nginx/conf/nginx.conf',
    command: '/opt/yuyan/nginx/sbin/nginx -p /opt/yuyan/nginx/ -c /opt/yuyan/nginx/conf/nginx.conf',
  }]);
});

test('解析 Nginx 版本、prefix 和默认配置路径', () => {
  assert.deepEqual(
    parseNginxVersionOutput('nginx version: openresty/1.25.3.2\nconfigure arguments: --prefix=/opt/openresty/nginx --conf-path=conf/nginx.conf --with-http_ssl_module'),
    { version: 'openresty/1.25.3.2', prefix: '/opt/openresty/nginx', configPath: 'conf/nginx.conf' }
  );
});

test('结构化解析 IPv4、IPv6、SSL、通配与 Unix Socket listen', () => {
  assert.deepEqual(parseNginxDiscoveryListen(['127.0.0.1:8080']), {
    raw: '127.0.0.1:8080', address: '127.0.0.1', port: 8080, transport: 'tcp', ssl: false, defaultServer: false, wildcard: false, loopback: true,
  });
  assert.deepEqual(parseNginxDiscoveryListen(['[::]:443', 'ssl', 'default_server']), {
    raw: '[::]:443 ssl default_server', address: '::', port: 443, transport: 'tcp', ssl: true, defaultServer: true, wildcard: true, loopback: false,
  });
  assert.deepEqual(parseNginxDiscoveryListen(['unix:/run/nginx.sock']), {
    raw: 'unix:/run/nginx.sock', address: '/run/nginx.sock', port: null, transport: 'unix', ssl: false, defaultServer: false, wildcard: false, loopback: true,
  });
});

test('访问地址忽略占位 server_name，并回退到服务器配置 IP', () => {
  const listens = [parseNginxDiscoveryListen(['*:9999'])];
  assert.deepEqual(buildNginxAccessEndpoints(listens, ['_', 'SERVER_URL'], '192.168.165.13'), [{
    url: 'http://192.168.165.13:9999',
    host: '192.168.165.13',
    port: 9999,
    protocol: 'http',
    source: 'serverHost',
    scope: 'remote',
  }]);
});

test('通过 proc exe/cwd 解析相对二进制，缺少依据时禁止执行', () => {
  const procPaths = parseNginxProcPaths('101\t/opt/yuyan/nginx/sbin/nginx\t/opt/yuyan/nginx\n202\t\t/home/nginx\n');
  assert.deepEqual(resolveNginxProcessBinary({ binary: './nginx' }, procPaths.get(101), []), {
    binary: '/opt/yuyan/nginx/sbin/nginx', status: 'resolved',
  });
  assert.deepEqual(resolveNginxProcessBinary({ binary: './sbin/nginx' }, procPaths.get(202), []), {
    binary: '/home/nginx/sbin/nginx', status: 'resolved',
  });
  assert.deepEqual(resolveNginxProcessBinary({ binary: './nginx' }, {}, []), {
    binary: './nginx', status: 'unresolved',
  });
});

test('结构化诊断按稳定键去重', () => {
  const diagnostic = { code: 'permission_denied', severity: 'warning', scope: 'runtime', summary: '权限不足' };
  assert.deepEqual(dedupeNginxDiagnostics([diagnostic, { ...diagnostic }, { ...diagnostic, scope: 'scan' }]), [
    diagnostic,
    { ...diagnostic, scope: 'scan' },
  ]);
});

test('展开配置按来源文件提取静态、混合、alias 和动态 root 站点', () => {
  const sections = parseNginxDumpSections(NGINX_DUMP, '/fallback/nginx.conf');
  const sites = parseNginxDiscoverySites(sections, 'runtime-1');
  assert.equal(sections.length, 2);
  assert.equal(sites.length, 3);
  assert.deepEqual(sites[0].listenPorts, [32088]);
  assert.deepEqual(sites[0].serverNames, ['portal.example.com', '_']);
  assert.deepEqual(sites[0].roots, ['/opt/yuyan/html']);
  assert.equal(sites[0].configPath, '/home/nginx/conf/conf.d/apps.conf');
  assert.equal(sites[0].type, 'mixed');
  assert.deepEqual(sites[1].aliases, ['/home/files']);
  assert.deepEqual(sites[1].roots, ['/home/nginx/default-html']);
  assert.equal(sites[1].type, 'static');
  assert.deepEqual(sites[2].dynamicRoots, ['/srv/$host']);
  assert.deepEqual(sites[2].roots, []);
});

test('服务器发现使用 sudo -n 展开配置并标记已接入实例', async () => {
  const commands = [];
  const root = '/opt/yuyan/html';
  const result = await discoverServerNginx(7, { useSudo: true }, {
    getServer: async () => ({
      id: 7,
      useSudo: true,
      nginxInstances: [{ id: 8, instanceType: 'external', defaultNginxConfPath: '/home/nginx/conf/conf.d/apps.conf' }],
    }),
    withConnection: async (_server, task) => task({ fake: true }),
    execute: async (_conn, command, options = {}) => {
      commands.push(command);
      if (options.label === '扫描 Nginx master 进程') {
        return { code: 0, stdout: '101 root nginx: master process /home/nginx/sbin/nginx -p /home/nginx -c conf/nginx.conf\n', stderr: '' };
      }
      if (options.label === '扫描常见 Nginx 安装路径') {
        return { code: 0, stdout: '/home/nginx/sbin/nginx\n', stderr: '' };
      }
      if (String(options.label || '').startsWith('读取 ')) {
        return {
          code: 0,
          stdout: '',
          stderr: 'nginx version: nginx/1.26.2\nconfigure arguments: --prefix=/home/nginx --conf-path=conf/nginx.conf',
        };
      }
      if (String(options.label || '').startsWith('扫描 ')) return { code: 0, stdout: NGINX_DUMP, stderr: '' };
      if (options.label === '检查 Nginx 前端目录') {
        return { code: 0, stdout: `${Buffer.from(root).toString('base64')}\t1\t1\t1\n`, stderr: '' };
      }
      throw new Error(`未处理命令：${command}`);
    },
  });

  assert.equal(result.runtimes.length, 1);
  assert.equal(result.runtimes[0].running, true);
  assert.equal(result.runtimes[0].mainConfigPath, '/home/nginx/conf/nginx.conf');
  assert.equal(result.runtimes[0].connectedInstanceId, 8);
  assert.equal(result.runtimes[0].sites[0].roots[0].hasIndexHtml, true);
  assert.equal(result.runtimes[0].sites[0].roots[0].readable, true);
  assert.match(result.runtimes[0].nginxTestCommand, /^'\/home\/nginx\/sbin\/nginx' -t/);
  assert.equal(result.runtimes[0].nginxTestCommand.includes('sudo'), false);
  assert.equal(commands.some((command) => command.includes('sudo -n find /home /opt')), true);
  assert.equal(commands.some((command) => command.startsWith("sudo -n '/home/nginx/sbin/nginx' -T")), true);
});

test('sudo 需要交互密码时保留运行实例并给出手工接入提示', async () => {
  const result = await discoverServerNginx(9, { useSudo: true }, {
    getServer: async () => ({ id: 9, useSudo: true, nginxInstances: [] }),
    withConnection: async (_server, task) => task({ fake: true }),
    execute: async (_conn, _command, options = {}) => {
      if (options.label === '扫描 Nginx master 进程') {
        return { code: 0, stdout: '101 root nginx: master process /opt/nginx/sbin/nginx\n', stderr: '' };
      }
      if (options.label === '扫描常见 Nginx 安装路径') return { code: 0, stdout: '/opt/nginx/sbin/nginx\n', stderr: '' };
      if (String(options.label || '').startsWith('读取 ')) return { code: 0, stdout: '', stderr: 'nginx version: nginx/1.24.0' };
      return { code: 1, stdout: '', stderr: 'sudo: a password is required' };
    },
  });

  assert.equal(result.runtimes.length, 1);
  assert.equal(result.runtimes[0].sites.length, 0);
  assert.equal(result.runtimes[0].diagnostics.some((item) => item.code === 'sudo_password_required'), true);
});

test('普通账号读取权限不足时提示开启 sudo', async () => {
  const result = await discoverServerNginx(10, { useSudo: false }, {
    getServer: async () => ({ id: 10, useSudo: false, nginxInstances: [] }),
    withConnection: async (_server, task) => task({ fake: true }),
    execute: async (_conn, _command, options = {}) => {
      if (options.label === '扫描 Nginx master 进程') {
        return { code: 0, stdout: 'root 436 1 0 Jul07 ? 00:00:00 nginx: master process /opt/nginx/sbin/nginx\n', stderr: '' };
      }
      if (options.label === '扫描常见 Nginx 安装路径') return { code: 0, stdout: '/opt/nginx/sbin/nginx\n', stderr: '' };
      if (String(options.label || '').startsWith('读取 ')) return { code: 0, stdout: '', stderr: 'nginx version: nginx/1.24.0' };
      return { code: 1, stdout: '', stderr: 'open() "/opt/nginx/logs/error.log" failed (13: Permission denied)' };
    },
  });

  assert.equal(result.runtimes[0].sites.length, 0);
  assert.equal(result.runtimes[0].diagnostics.some((item) => item.code === 'permission_denied' && item.action.includes('使用 sudo')), true);
});
