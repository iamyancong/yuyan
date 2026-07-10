/**
 * 后端 Java 工具链检测服务
 * @description 检测本机构建 JDK 与服务器运行 JDK，不静默使用未验证路径。
 */

import path from 'node:path';
import {
  createServerJavaRuntime,
  getJdk,
  getServerJavaRuntime,
  getServerWithCredential,
  listServerJavaRuntimes,
  updateJdkDetection,
  updateServerJavaRuntimeDetection,
} from './deploy-store.mjs';
import { parseJavaMajorVersion, redactDeployLog } from './backend-domain.mjs';
import { runBackendLocalCommand } from './backend-project-service.mjs';
import { execSsh, shellQuote, withSsh } from './ssh-service.mjs';

/**
 * 从 java -version 输出解析检测结果。
 * @param {string} output 命令输出
 * @returns {Object} 检测结果
 */
export function parseJavaDetection(output) {
  const text = redactDeployLog(output).trim();
  const version = text.match(/(?:java|openjdk) version ["']([^"']+)/i)?.[1]
    || text.match(/openjdk\s+([^\s]+)/i)?.[1]
    || '';
  const vendor = text.split(/\r?\n/).find((line) => /runtime environment|openjdk|java/i.test(line))?.trim() || '';
  return {
    javaVersion: version,
    majorVersion: parseJavaMajorVersion(text),
    vendor,
    arch: process.arch,
    status: parseJavaMajorVersion(text) ? 'available' : 'unavailable',
    statusOutput: text,
  };
}

/**
 * 检测本机构建 JDK。
 * @param {number} id JDK ID
 * @returns {Promise<Object>} JDK 配置
 */
export async function testBuildJdk(id) {
  const jdk = await getJdk(id);
  if (!jdk) throw new Error('构建 JDK 不存在');
  try {
    const javaBin = path.join(jdk.homePath, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    const result = await runBackendLocalCommand(`${shellQuote(javaBin)} -version`, { label: '检测本机 JDK', timeoutMs: 15000 });
    const detection = parseJavaDetection(`${result.stdout}\n${result.stderr}`);
    return updateJdkDetection(id, detection);
  } catch (error) {
    await updateJdkDetection(id, { status: 'unavailable', statusOutput: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/**
 * 检测服务器 Java 运行时。
 * @param {number} id 运行时 ID
 * @returns {Promise<Object>} 运行时配置
 */
export async function testServerJavaRuntime(id) {
  const runtime = await getServerJavaRuntime(id);
  if (!runtime) throw new Error('服务器 Java 运行时不存在');
  const server = await getServerWithCredential(runtime.serverId);
  if (!server) throw new Error('部署服务器不存在');
  try {
    const output = await withSsh(server, async (conn) => {
      const javaBin = path.posix.join(runtime.homePath, 'bin', 'java');
      const result = await execSsh(conn, `${shellQuote(javaBin)} -version 2>&1`, { label: '检测服务器 JDK' });
      return `${result.stdout}\n${result.stderr}`;
    });
    const detection = { ...parseJavaDetection(output), arch: '' };
    return updateServerJavaRuntimeDetection(id, detection);
  } catch (error) {
    await updateServerJavaRuntimeDetection(id, { status: 'unavailable', statusOutput: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/**
 * 扫描服务器常见 JAVA_HOME 并写入未配置项。
 * @param {number} serverId 服务器 ID
 * @returns {Promise<Object[]>} 检测后的运行时列表
 */
export async function scanServerJavaRuntimes(serverId) {
  const server = await getServerWithCredential(serverId);
  if (!server) throw new Error('部署服务器不存在');
  const paths = await withSsh(server, async (conn) => {
    const command = `for java in "$(command -v java 2>/dev/null)" /usr/lib/jvm/*/bin/java /opt/java/*/bin/java; do [ -x "$java" ] || continue; home="$(cd "$(dirname "$java")/.." && pwd -P)"; echo "$home"; done | awk '!seen[$0]++'`;
    const result = await execSsh(conn, command, { allowFailure: true, label: '扫描服务器 JDK' });
    return result.stdout.split(/\r?\n/).map((item) => item.trim()).filter((item) => item.startsWith('/'));
  });
  const current = await listServerJavaRuntimes(serverId);
  for (const homePath of paths) {
    if (current.some((item) => item.homePath === homePath)) continue;
    await createServerJavaRuntime(serverId, { name: path.posix.basename(homePath), homePath });
  }
  const runtimes = await listServerJavaRuntimes(serverId);
  await Promise.all(runtimes.map((runtime) => testServerJavaRuntime(runtime.id).catch(() => null)));
  return listServerJavaRuntimes(serverId);
}
