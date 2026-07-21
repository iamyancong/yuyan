import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  getBackendCommandNotFoundHint,
  inspectBackendRepository,
  prepareBackendMavenCommand,
  resolveBackendArtifact,
} from '../backend-project-service.mjs';

/** 创建最小 Maven 多模块测试项目。 */
async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-backend-'));
  const starter = path.join(root, 'valuation-outsourced-starter');
  const resources = path.join(starter, 'src/main/resources');
  await fs.mkdir(resources, { recursive: true });
  await fs.writeFile(path.join(root, 'pom.xml'), '<project><properties><java.version>8</java.version></properties></project>');
  await fs.writeFile(path.join(starter, 'pom.xml'), `
    <project>
      <parent><artifactId>parent-wrong-name</artifactId></parent>
      <artifactId>valuation-outsourced-starter</artifactId>
      <build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build>
    </project>
  `);
  await fs.writeFile(path.join(resources, 'bootstrap.yml'), `server:\n  port: 9999\nspring:\n  application:\n    name: yss-valuation-outsourced\n  profiles:\n    active: local\nmanagement:\n  endpoints:\n    web:\n      base-path: /monitor\n`);
  await fs.writeFile(path.join(resources, 'smart-doc.json'), '{"outPath":"target/openapi"}');
  return root;
}

test('检测 Java、启动模块、端口、健康路径、Jar 与 smart-doc', async (t) => {
  const root = await createFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await inspectBackendRepository(root);
  assert.equal(result.javaMajorVersion, 8);
  assert.equal(result.starterModule, 'valuation-outsourced-starter');
  assert.equal(result.applicationName, 'yss-valuation-outsourced');
  assert.equal(result.serverPort, 9999);
  assert.equal(result.healthCheckPath, '/monitor/health');
  assert.equal(result.artifactPattern, 'valuation-outsourced-starter/target/valuation-outsourced-starter-*.jar');
  assert.equal(result.openapiOutputPath, 'valuation-outsourced-starter/target/openapi/openapi.json');
});

test('Jar 匹配排除 sources/original 并要求唯一', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-jar-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'starter/target');
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'app-1.jar'), 'jar');
  await fs.writeFile(path.join(target, 'app-1-sources.jar'), 'sources');
  await fs.writeFile(path.join(target, 'app-1.jar.original'), 'original');
  await fs.writeFile(path.join(target, 'original-app-1.jar'), 'original-prefix');
  const artifact = await resolveBackendArtifact(root, 'starter/target/app-*.jar');
  assert.equal(artifact.jarName, 'app-1.jar');
  await fs.writeFile(path.join(target, 'app-2.jar'), 'jar2');
  await assert.rejects(() => resolveBackendArtifact(root, 'starter/target/app-*.jar'), /多个文件/);
});

test('裸 mvn 在仓库存在 Wrapper 时自动改写并保留参数', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuyan-maven-wrapper-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const wrapperPath = path.join(root, 'mvnw');
  await fs.writeFile(wrapperPath, '#!/bin/sh\nexit 0\n');
  await fs.chmod(wrapperPath, 0o755);

  const logs = [];
  const command = await prepareBackendMavenCommand('mvn clean package -DskipTests', root, {
    onLog: (_level, message) => logs.push(message),
  });
  assert.equal(command, './mvnw clean package -DskipTests');
  assert.match(logs.join('\n'), /Maven Wrapper/);
});

test('Maven 退出码 127 返回可操作诊断', () => {
  const hint = getBackendCommandNotFoundHint(127, '/bin/sh: mvn: command not found');
  assert.match(hint, /找不到 Maven/);
  assert.match(hint, /.\/mvnw/);
  assert.equal(getBackendCommandNotFoundHint(1, 'BUILD FAILURE'), '');
});
