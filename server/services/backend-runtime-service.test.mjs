import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPidServiceScript } from './backend-runtime-service.mjs';

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
  assert.doesNotMatch(script, /pgrep\s+-f/);
  assert.doesNotMatch(script, /kill\s+-9\s+\$\(/);
  assert.match(script, /nohup .*'\$\(touch'/);
});
