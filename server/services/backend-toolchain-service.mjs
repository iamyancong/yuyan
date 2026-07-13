/**
 * 后端 Java 工具链检测服务
 * @description 检测本机构建 JDK 与服务器运行 JDK，不静默使用未验证路径。
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import {
  createServerJavaRuntime,
  createJdk,
  getJdk,
  getServerJavaRuntime,
  getServerWithCredential,
  listServerJavaRuntimes,
  listJdks,
  updateJdkDetection,
  updateServerJavaRuntimeDetection,
} from './deploy-store.mjs';
import { parseJavaMajorVersion, redactDeployLog } from './backend-domain.mjs';
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
 * 直接执行本机可执行文件（不经过 shell），避免 macOS Tauri 子进程的 /bin/sh 安全限制。
 * @param {string} bin 可执行文件绝对路径
 * @param {string[]} args 参数列表
 * @param {Object} [options] 选项
 * @param {number} [options.timeoutMs] 超时时间
 * @returns {Promise<{stdout: string, stderr: string}>} 执行结果
 */
function execFileDirect(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: options.timeoutMs || 15000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`检测本机 JDK执行失败，退出码 ${error.code ?? 'unknown'}\n${redactDeployLog(stderr || stdout || error.message).trim()}`));
        return;
      }
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/**
 * 检测本机构建 JDK。
 * 使用 execFile 直接执行 Java 二进制文件，不经过 /bin/sh，
 * 避免 macOS Tauri 子进程环境下 shell 无法定位外部可执行文件的问题。
 * @param {number} id JDK ID
 * @returns {Promise<Object>} JDK 配置
 */
export async function testBuildJdk(id) {
  const jdk = await getJdk(id);
  if (!jdk) throw new Error('构建 JDK 不存在');
  try {
    const javaBin = path.join(jdk.homePath, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    const result = await execFileDirect(javaBin, ['-version']);
    const detection = parseJavaDetection(`${result.stdout}\n${result.stderr}`);
    return updateJdkDetection(id, detection);
  } catch (error) {
    await updateJdkDetection(id, { status: 'unavailable', statusOutput: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/**
 * 收集目录下的 JDK home 候选。
 * @param {Set<string>} candidates 候选集合
 * @param {string} root 版本目录根路径
 * @param {(entryPath: string) => string} resolveHome 从子目录解析 JAVA_HOME
 */
async function collectJavaHomes(candidates, root, resolveHome = (entryPath) => entryPath) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const entryPath = path.join(root, entry.name);
    const homePath = resolveHome(entryPath);
    const javaBin = path.join(homePath, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (await fs.access(javaBin).then(() => true).catch(() => false)) candidates.add(homePath);
  }
}

/** 从 JDK release 文件提取更准确的实现厂商。 */
async function readJdkImplementor(homePath) {
  const release = await fs.readFile(path.join(homePath, 'release'), 'utf8').catch(() => '');
  return release.match(/^IMPLEMENTOR="([^"]+)"/m)?.[1] || '';
}

/**
 * 扫描本机已安装的真实 JDK，并逐个执行 java -version。
 * @returns {Promise<Object[]>} 已刷新检测状态的 JDK 列表
 */
export async function scanLocalBuildJdks() {
  const candidates = new Set();
  if (process.env.JAVA_HOME) candidates.add(String(process.env.JAVA_HOME));
  const home = os.homedir();
  await collectJavaHomes(candidates, path.join(home, '.sdkman', 'candidates', 'java'));
  await collectJavaHomes(candidates, path.join(home, '.jenv', 'versions'));
  if (process.platform === 'darwin') {
    await collectJavaHomes(candidates, path.join(home, 'Library', 'Java', 'JavaVirtualMachines'), (entryPath) => path.join(entryPath, 'Contents', 'Home'));
    await collectJavaHomes(candidates, '/Library/Java/JavaVirtualMachines', (entryPath) => path.join(entryPath, 'Contents', 'Home'));
  }

  const existing = await listJdks();
  const existingByRealPath = new Map();
  for (const jdk of existing) {
    const real = await fs.realpath(jdk.homePath).catch(() => path.resolve(jdk.homePath));
    existingByRealPath.set(real, jdk);
  }

  for (const candidate of candidates) {
    const homePath = await fs.realpath(candidate).catch(() => '');
    if (!homePath) continue;
    const javaBin = path.join(homePath, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    try {
      const result = await execFileDirect(javaBin, ['-version']);
      const parsed = parseJavaDetection(`${result.stdout}\n${result.stderr}`);
      const implementor = await readJdkImplementor(homePath);
      const detection = { ...parsed, vendor: implementor || parsed.vendor };
      const current = existingByRealPath.get(homePath);
      if (current) {
        await updateJdkDetection(current.id, detection);
      } else {
        const created = await createJdk({
          name: `${implementor || 'JDK'} ${detection.majorVersion}`,
          homePath,
          ...detection,
          lastCheckedAt: new Date().toISOString(),
          remark: '本机扫描',
        });
        existingByRealPath.set(homePath, created);
      }
    } catch {
    }
  }

  const refreshed = await listJdks();
  await Promise.all(refreshed.map((jdk) => testBuildJdk(jdk.id).catch(() => null)));
  return listJdks();
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
