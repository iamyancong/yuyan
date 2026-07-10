import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBackendConfig,
  parseJavaMajorVersion,
  parseRuntimeArguments,
  redactDeployLog,
  validateBackendDeployRoot,
  validateBackendServerPort,
  validateOpenApiContent,
  validateRepositoryRelativePath,
} from './backend-domain.mjs';

test('解析 Java 8、17 和新版 java -version 输出', () => {
  assert.equal(parseJavaMajorVersion('java version "1.8.0_382"'), 8);
  assert.equal(parseJavaMajorVersion('openjdk version "17.0.12" 2024-07-16'), 17);
  assert.equal(parseJavaMajorVersion('openjdk 24.0.1 2025-04-15'), 24);
});

test('仓库路径和部署路径拒绝绝对路径与目录穿越', () => {
  assert.equal(validateRepositoryRelativePath('starter/target/app-*.jar', 'Jar', { allowGlob: true }), 'starter/target/app-*.jar');
  assert.throws(() => validateRepositoryRelativePath('../secret', '文件'), /不能跳出/);
  assert.throws(() => validateRepositoryRelativePath('/tmp/app.jar', '文件'), /相对路径/);
  assert.equal(validateBackendDeployRoot('/home/guest/huagui/backend/app'), '/home/guest/huagui/backend/app');
  assert.throws(() => validateBackendDeployRoot('home/guest/app'), /绝对路径/);
});

test('端口边界和低端口授权限制', () => {
  assert.equal(validateBackendServerPort(9999), 9999);
  assert.throws(() => validateBackendServerPort(0), /1-65535/);
  assert.throws(() => validateBackendServerPort(65536), /1-65535/);
  assert.throws(() => validateBackendServerPort(80), /授权模式/);
  assert.equal(validateBackendServerPort(80, { useSudo: true }), 80);
});

test('OpenAPI 校验要求版本和 paths 并限制大小', () => {
  const valid = validateOpenApiContent(Buffer.from(JSON.stringify({ openapi: '3.0.3', paths: {} })));
  assert.match(valid.pretty, /"openapi": "3\.0\.3"/);
  assert.throws(() => validateOpenApiContent(Buffer.from('{oops')), /JSON/);
  assert.throws(() => validateOpenApiContent(Buffer.from(JSON.stringify({ openapi: '3.0.3' }))), /paths/);
  assert.throws(() => validateOpenApiContent(Buffer.alloc(20 * 1024 * 1024 + 1)), /20MB/);
});

test('后端配置统一规范化且日志会脱敏', () => {
  const config = normalizeBackendConfig({
    projectName: 'valuation-outsourced',
    buildJdkId: 1,
    runtimeJavaHome: '/opt/java8',
    serverPort: 9999,
    artifactPattern: 'starter/target/app-*.jar',
    healthCheckPath: 'monitor/health',
  });
  assert.equal(config.serviceName, 'valuation-outsourced');
  assert.equal(config.healthCheckPath, '/monitor/health');
  assert.equal(config.stopTimeoutSeconds, 30);
  assert.doesNotMatch(redactDeployLog('password=abc token: xyz Authorization: Bearer 123'), /abc|xyz|123/);
});

test('JVM 和应用参数按参数解析，命令替换不会作为 shell 语法执行', () => {
  assert.deepEqual(parseRuntimeArguments('-Xms512m -Dname="hello world" $(touch /tmp/pwned)'), [
    '-Xms512m',
    '-Dname=hello world',
    '$(touch',
    '/tmp/pwned)',
  ]);
  assert.throws(() => parseRuntimeArguments('-Dname="broken'), /未闭合/);
});
