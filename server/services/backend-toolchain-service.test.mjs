import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildServerJavaScanCommand,
  parseJavaDetection,
  parseMacJavaHomes,
} from './backend-toolchain-service.mjs';

test('解析 macOS java_home 输出中的多个 JDK 路径并去重', () => {
  const output = `Matching Java Virtual Machines (2):
    24.0.1 (arm64) "Oracle" - "OpenJDK 24" /Users/demo/Library/Java/JavaVirtualMachines/openjdk-24/Contents/Home
    1.8.0_482 (arm64) "Temurin" - "Java 8" /Users/demo/.sdkman/candidates/java/8.0.482-tem/Contents/Home
/Users/demo/Library/Java/JavaVirtualMachines/openjdk-24/Contents/Home`;

  assert.deepEqual(parseMacJavaHomes(output), [
    '/Users/demo/Library/Java/JavaVirtualMachines/openjdk-24/Contents/Home',
    '/Users/demo/.sdkman/candidates/java/8.0.482-tem/Contents/Home',
  ]);
});

test('服务器扫描覆盖 usr/java 和常见 JDK 路径并解析符号链接', () => {
  const command = buildServerJavaScanCommand();
  assert.match(command, /\/usr\/java\/\*\/bin\/java/);
  assert.match(command, /\/usr\/lib\/jvm\/\*\/bin\/java/);
  assert.match(command, /\.sdkman\/candidates\/java\/\*\/bin\/java/);
  assert.match(command, /readlink -f/);
});

test('解析 Java 8 与新版 OpenJDK 检测结果', () => {
  assert.equal(parseJavaDetection('openjdk version "1.8.0_482"').majorVersion, 8);
  assert.equal(parseJavaDetection('openjdk version "24.0.1" 2025-04-15').majorVersion, 24);
});
