import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBackendReleaseCompatibilityCommand,
  buildBackendRootCompatibilityCommand,
  buildPidServiceScript,
  normalizeNacosRuntimeAddress,
  normalizePublishedJarName,
} from '../backend-runtime-service.mjs';

test('CI 发布文件名移除 SNAPSHOT 且不改变正式版本名', () => {
  assert.equal(
    normalizePublishedJarName('valuation-outsourced-starter-3.0.0-SNAPSHOT.jar'),
    'valuation-outsourced-starter-3.0.0.jar'
  );
  assert.equal(normalizePublishedJarName('valuation-outsourced-starter-3.0.0.jar'), 'valuation-outsourced-starter-3.0.0.jar');
  assert.equal(normalizePublishedJarName('../starter-1.0.0-snapshot.jar'), 'starter-1.0.0.jar');
  assert.throws(() => normalizePublishedJarName('starter-SNAPSHOT.zip'), /必须以 \.jar 结尾/);
});

test('Nacos Java 运行地址移除协议、路径和尾斜杠', () => {
  assert.equal(normalizeNacosRuntimeAddress('http://192.168.100.113:8848/'), '192.168.100.113:8848');
  assert.equal(normalizeNacosRuntimeAddress('localhost:8848'), 'localhost:8848');
  assert.equal(normalizeNacosRuntimeAddress('https://nacos.example.com/nacos'), 'nacos.example.com');
});

test('后端根目录兼容旧部署目录且不覆盖已有内容', () => {
  const command = buildBackendRootCompatibilityCommand({ root: '/home/guest/backend/app' });
  assert.match(command, /shared\/config/);
  assert.match(command, /shared\/logs/);
  assert.match(command, /shared\/nas/);
  assert.match(command, /target/);
  assert.match(command, /current/);
  assert.match(command, /\[ ! -e/);
  assert.match(command, /\[ ! -L/);
  assert.doesNotMatch(command, /ln -sfn/);
});

test('每个后端版本兼容共享目录和原始 Jar 名称', () => {
  const command = buildBackendReleaseCompatibilityCommand(
    {
      root: '/home/guest/backend/app',
      configDir: '/home/guest/backend/app/shared/config',
      logsDir: '/home/guest/backend/app/shared/logs',
      nasDir: '/home/guest/backend/app/shared/nas',
      runtimeJarFileName: '.yuyan-runtime.jar',
    },
    '/home/guest/backend/app/releases/20260712-a1b2c3',
    'valuation-outsourced-starter-1.0.0.jar'
  );
  assert.match(command, /\.\.\/\.\.\/shared\/config/);
  assert.match(command, /\.\.\/\.\.\/shared\/logs/);
  assert.match(command, /\.\.\/\.\.\/shared\/nas/);
  assert.match(command, /valuation-outsourced-starter-1\.0\.0\.jar/);
  assert.match(command, /\.yuyan-runtime\.jar/);
});

test('PID 脚本只使用受控 PID 文件并执行 TERM 后超时 KILL', () => {
  const script = buildPidServiceScript(
    {
      serviceName: 'valuation-outsourced',
      runtimeJavaHome: '/opt/java8',
      serverPort: 9999,
      stopTimeoutSeconds: 30,
      healthCheckPath: '/monitor/health',
      springProfiles: 'local',
      jvmOptions: '',
      appArgs: '$(touch /tmp/yuyan-pwned)',
      externalConfigPath: '',
    },
    {
      root: '/srv/app',
      currentLink: '/srv/app/current',
      currentRuntimeJar: '/srv/app/current/.yuyan-runtime.jar',
      legacyCurrentJar: '/srv/app/current/app.jar',
      environmentFile: '/srv/app/shared/config/yuyan-service.env',
      runDir: '/srv/app/shared/run',
      logFile: '/srv/app/shared/logs/service.log',
      pidFile: '/srv/app/shared/run/service.pid',
    }
  );
  assert.match(script, /\/proc\/\$pid\/cmdline/);
  assert.match(script, /kill -TERM "\$pid"/);
  assert.match(script, /kill -KILL "\$pid"/);
  assert.match(script, /KILL_GRACE=10/);
  assert.match(script, /REFUSE_UNMANAGED_PID/);
  assert.match(script, /\.yuyan-runtime\.jar/);
  assert.doesNotMatch(script, /pgrep\s+-f/);
  assert.doesNotMatch(script, /kill\s+-9\s+\$\(/);
  assert.match(script, /nohup .*'\$\(touch'/);
  assert.match(script, /ENV_FILE=.*yuyan-service\.env/);
  assert.match(script, /\. "\$ENV_FILE"/);
});

test('PID 脚本从受保护环境文件注入 Nacos 参数且不包含明文凭据', () => {
  const script = buildPidServiceScript(
    {
      runtimeJavaHome: '/opt/java8',
      serverPort: 9999,
      stopTimeoutSeconds: 30,
      springProfiles: '',
      jvmOptions: '-server -Xms512m -Xmx512m -Dapp.env=prod',
      appArgs: '',
      externalConfigPath: '',
      nacosServerAddr: 'localhost:8848',
    },
    {
      root: '/srv/app',
      currentLink: '/srv/app/current',
      currentRuntimeJar: '/srv/app/current/.yuyan-runtime.jar',
      legacyCurrentJar: '/srv/app/current/app.jar',
      environmentFile: '/srv/app/shared/config/yuyan-service.env',
      logFile: '/srv/app/shared/logs/app.log',
      pidFile: '/srv/app/shared/run/app.pid',
    }
  );
  assert.match(script, /-Dapp\.env=prod/);
  assert.match(script, /-Dnacosserver=\$\{NACOS_SERVER_ADDR\}/);
  assert.match(script, /-Dnacos_username=\$\{NACOS_USERNAME\}/);
  assert.match(script, /-Dnacos_password=\$\{NACOS_PASSWORD\}/);
  assert.doesNotMatch(script, /nacos-secret-value/);
});
