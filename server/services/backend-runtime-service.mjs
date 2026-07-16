/**
 * 后端服务远程运行时
 * @description 实现 Java 后端版本化发布、PID/systemd 进程托管、健康检查、服务操作和回滚。
 */

import path from 'node:path';
import {
  activateBackendRelease,
  createBackendRelease,
  createRecord,
  getBackendReleaseByRecordId,
  getCurrentBackendRelease,
  getJdk,
  findJdkByAlias,
  getDeployEnvironmentWithCredential,
  getServerJavaRuntime,
  updateDeployEnvironmentStatus,
  getRecord,
  getServerWithCredential,
  getTarget,
  listBackendReleases,
  updateBackendReleaseStatus,
  updateBackendServiceStatus,
  updateRecord,
} from './deploy-store.mjs';
import {
  createFileSha256,
  resolveBackendArtifact,
  runBackendLocalCommand,
  syncBackendWorkspace,
} from './backend-project-service.mjs';
import { execSsh, shellQuote, uploadFile, withSsh } from './ssh-service.mjs';
import {
  DEFAULT_BACKEND_RELEASE_KEEP,
  parseJavaMajorVersion,
  parseRuntimeArguments,
  redactDeployLog,
  validateBackendDeployRoot,
} from './backend-domain.mjs';

/** 本地 Maven 构建并发数 */
const MAX_BACKEND_BUILDS = 2;

/** 当前本地 Maven 构建数量 */
let activeBackendBuilds = 0;

/** 同一服务器的激活阶段队列 */
const serverActivationTails = new Map();

/**
 * 生成后端发布名称。
 * @returns {string} 发布名称
 */
function createBackendReleaseName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(16).slice(2, 8)}`;
}

/**
 * 规范服务器发布 Jar 文件名。
 * @description 仅移除文件扩展名前的 SNAPSHOT 标识，不修改 Maven 项目版本和产物内容。
 * @param {string} jarName Maven 构建产物文件名
 * @returns {string} 服务器发布文件名
 */
export function normalizePublishedJarName(jarName) {
  const safeName = path.posix.basename(String(jarName || '').trim());
  if (!safeName.toLowerCase().endsWith('.jar')) throw new Error('构建产物文件名必须以 .jar 结尾');
  const normalized = safeName.replace(/-SNAPSHOT(?=\.jar$)/i, '');
  return normalized === '.jar' ? safeName : normalized;
}

/**
 * 等待一段时间并支持取消。
 * @param {number} ms 毫秒
 * @param {AbortSignal} signal 取消信号
 * @returns {Promise<void>}
 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('任务已取消'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      reject(new Error('任务已取消'));
    }, { once: true });
  });
}

/**
 * 以本地构建并发槽执行任务。
 * @param {() => Promise<*>} runner 任务
 * @returns {Promise<*>} 结果
 */
async function withBackendBuildSlot(runner) {
  if (activeBackendBuilds >= MAX_BACKEND_BUILDS) throw new Error('当前已有 2 个后端构建任务，请稍后重试');
  activeBackendBuilds += 1;
  try {
    return await runner();
  } finally {
    activeBackendBuilds -= 1;
  }
}

/**
 * 串行执行同一服务器的激活阶段。
 * @param {number} serverId 服务器 ID
 * @param {() => Promise<*>} runner 任务
 * @returns {Promise<*>} 结果
 */
async function withServerActivationLock(serverId, runner) {
  const previous = serverActivationTails.get(serverId) || Promise.resolve();
  let releaseTail;
  const current = new Promise((resolve) => {
    releaseTail = resolve;
  });
  const tail = previous.then(() => current);
  serverActivationTails.set(serverId, tail);
  await previous;
  try {
    return await runner();
  } finally {
    releaseTail();
    if (serverActivationTails.get(serverId) === tail) serverActivationTails.delete(serverId);
  }
}

/**
 * 获取后端目标、服务器和构建 JDK。
 * @param {number} targetId 目标 ID
 * @param {{requireBuild?: boolean}} options 校验选项
 * @returns {Promise<{target: Object, server: Object, buildJdk: Object|null}>} 上下文
 */
async function getBackendContext(targetId, options = {}) {
  const requireBuild = options.requireBuild !== false;
  const target = await getTarget(targetId);
  if (!target || target.projectType !== 'backend') throw new Error('后端部署目标不存在');
  const server = await getServerWithCredential(target.serverId);
  if (!server) throw new Error('部署服务器不存在');
  let buildJdk = target.buildJdkId ? await getJdk(target.buildJdkId) : null;
  if (requireBuild && (!buildJdk || buildJdk.status !== 'available') && target.requiredJdkAlias) {
    const matchedLocal = await findJdkByAlias(target.requiredJdkAlias);
    if (matchedLocal) {
      buildJdk = matchedLocal;
      target.buildJdkId = matchedLocal.id;
    }
  }
  const environment = target.environmentId ? await getDeployEnvironmentWithCredential(target.environmentId) : null;
  const serverJavaRuntime = target.serverJavaRuntimeId ? await getServerJavaRuntime(target.serverJavaRuntimeId) : null;
  if (requireBuild && (!buildJdk || buildJdk.status !== 'available' || !buildJdk.majorVersion)) {
    throw new Error(`本地未检测到满足要求的 Java ${target.requiredJdkAlias || ''} 构建环境，请先在 Java 环境管理中检测并绑定您的本地环境`);
  }
  if (target.processMode === 'legacy' || target.needsReview) {
    throw new Error('该目标仍使用历史自定义启停命令，请编辑并保存为 PID 或 systemd 模式后再操作');
  }
  if (target.serverJavaRuntimeId) {
    if (!serverJavaRuntime || Number(serverJavaRuntime.serverId) !== Number(server.id)) throw new Error('所选服务器运行 JDK 不属于当前部署服务器');
    if (serverJavaRuntime.status !== 'available') throw new Error('所选服务器运行 JDK 未检测通过');
    target.runtimeJavaHome = serverJavaRuntime.homePath;
    target.runtimeJavaVersion = serverJavaRuntime.javaVersion || String(serverJavaRuntime.majorVersion || '');
  }
  if (!target.runtimeJavaHome) throw new Error('服务器运行 JAVA_HOME 必填');
  if (requireBuild && !target.buildCommand) throw new Error('Maven 构建命令必填');
  if (environment) {
    target.nacosServerAddr = environment.nacosServerAddr || target.nacosServerAddr || '';
    target.nacosConsoleUrl = environment.nacosConsoleUrl || target.nacosConsoleUrl || '';
    target.nacosNamespace = environment.nacosNamespace || target.nacosNamespace || '';
    target.nacosGroup = environment.nacosGroup || target.nacosGroup || '';
    target.gatewayUrl = environment.gatewayPublicUrl || target.gatewayUrl || '';
  }
  validateBackendDeployRoot(target.deployRoot, server.defaultBackendRoot);
  return { target, server, buildJdk, environment, serverJavaRuntime };
}

/**
 * 解析后端远程目录。
 * @param {Object} target 部署目标
 * @returns {Object} 远程目录集合
 */
function getBackendRuntimePaths(target) {
  const root = validateBackendDeployRoot(target.deployRoot);
  return {
    root,
    releasesDir: path.posix.join(root, 'releases'),
    currentLink: path.posix.join(root, 'current'),
    sharedDir: path.posix.join(root, 'shared'),
    configDir: path.posix.join(root, 'shared', 'config'),
    logsDir: path.posix.join(root, 'shared', 'logs'),
    nasDir: path.posix.join(root, 'shared', 'nas'),
    runDir: path.posix.join(root, 'shared', 'run'),
    binDir: path.posix.join(root, 'bin'),
    scriptPath: path.posix.join(root, 'bin', 'yuyan-service.sh'),
    runtimeJarFileName: '.yuyan-runtime.jar',
    currentRuntimeJar: path.posix.join(root, 'current', '.yuyan-runtime.jar'),
    legacyCurrentJar: path.posix.join(root, 'current', 'app.jar'),
    environmentFile: path.posix.join(root, 'shared', 'config', 'yuyan-service.env'),
    pidFile: path.posix.join(root, 'shared', 'run', 'app.pid'),
    logFile: path.posix.join(root, 'shared', 'logs', 'app.log'),
    lockDir: path.posix.join(root, 'shared', 'run', 'deploy.lock'),
  };
}

/**
 * 生成后端根目录的旧部署结构兼容命令。
 * @description 只在路径不存在时创建软链接，绝不覆盖服务器上已有的真实目录或链接。
 * @param {Object} paths 远程目录集合
 * @returns {string} Shell 命令
 */
export function buildBackendRootCompatibilityCommand(paths) {
  const links = [
    ['conf', 'shared/config'],
    ['logs', 'shared/logs'],
    ['nas', 'shared/nas'],
    ['target', 'current'],
  ];
  return links.map(([name, target]) => {
    const linkPath = path.posix.join(paths.root, name);
    return `if [ ! -e ${shellQuote(linkPath)} ] && [ ! -L ${shellQuote(linkPath)} ]; then ln -s ${shellQuote(target)} ${shellQuote(linkPath)}; fi`;
  }).join('; ');
}

/**
 * 生成单个版本目录的兼容命令。
 * @description Spring Boot 从 current 工作目录运行，因此为 config、logs、nas 创建共享目录入口；隐藏链接仅供进程托管稳定引用。
 * @param {Object} paths 远程目录集合
 * @param {string} releaseDir 版本目录
 * @param {string} jarName 构建产物原始文件名
 * @returns {string} Shell 命令
 */
export function buildBackendReleaseCompatibilityCommand(paths, releaseDir, jarName) {
  const links = [
    ['config', path.posix.relative(releaseDir, paths.configDir)],
    ['logs', path.posix.relative(releaseDir, paths.logsDir)],
    ['nas', path.posix.relative(releaseDir, paths.nasDir)],
  ];
  if (jarName) links.push([paths.runtimeJarFileName, path.posix.basename(jarName)]);
  return links.map(([name, target]) => {
    const linkPath = path.posix.join(releaseDir, name);
    return `if [ ! -e ${shellQuote(linkPath)} ] && [ ! -L ${shellQuote(linkPath)} ]; then ln -s ${shellQuote(target)} ${shellQuote(linkPath)}; fi`;
  }).join('; ');
}

/**
 * 写入远程文件。
 * @param {Object} conn SSH 连接
 * @param {string} filePath 文件路径
 * @param {string} content 内容
 * @param {{sudo?: boolean, executable?: boolean, mode?: string}} options 选项
 */
async function writeRemoteContent(conn, filePath, content, options = {}) {
  const encoded = Buffer.from(content, 'utf8').toString('base64');
  const tempPath = `/tmp/yuyan-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  await execSsh(conn, `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(tempPath)}`, { label: `准备 ${path.posix.basename(filePath)}` });
  const install = options.sudo
    ? `sudo -n mkdir -p ${shellQuote(path.posix.dirname(filePath))} && sudo -n mv ${shellQuote(tempPath)} ${shellQuote(filePath)}`
    : `mkdir -p ${shellQuote(path.posix.dirname(filePath))} && mv ${shellQuote(tempPath)} ${shellQuote(filePath)}`;
  const fileMode = options.executable ? '755' : String(options.mode || '').trim();
  await execSsh(conn, `${install}${fileMode ? ` && ${options.sudo ? 'sudo -n ' : ''}chmod ${fileMode} ${shellQuote(filePath)}` : ''}`, { label: `写入 ${filePath}` });
}

/**
 * 生成由受保护环境文件提供的 Nacos JVM 参数。
 * @param {Object} target 部署目标
 * @returns {string} JVM 参数片段
 */
function buildManagedNacosJvmOptions(target) {
  if (!target.nacosServerAddr) return '';
  return [
    '"-Dnacosserver=${NACOS_SERVER_ADDR}"',
    '"-Dnamespace=${NACOS_NAMESPACE}"',
    '"-Dspring.cloud.nacos.discovery.serverAddr=${NACOS_SERVER_ADDR}"',
    '"-Dspring.cloud.nacos.discovery.namespace=${NACOS_NAMESPACE}"',
    '"-Dnacos_group=${NACOS_GROUP}"',
    '"-Dnacos_username=${NACOS_USERNAME}"',
    '"-Dnacos_password=${NACOS_PASSWORD}"',
  ].join(' ');
}

/**
 * 规范化 Java 运行参数使用的 Nacos 地址。
 * @param {string} value Nacos 地址
 * @returns {string} host:port 形式地址
 */
export function normalizeNacosRuntimeAddress(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '').split('/')[0];
  }
}

/**
 * 生成 PID 管理脚本。
 * @param {Object} target 部署目标
 * @param {Object} paths 远程路径
 * @returns {string} 脚本内容
 */
export function buildPidServiceScript(target, paths = getBackendRuntimePaths(target)) {
  const javaBin = path.posix.join(target.runtimeJavaHome, 'bin', 'java');
  const profileArg = target.springProfiles ? ` ${shellQuote(`--spring.profiles.active=${target.springProfiles}`)}` : '';
  const configArg = target.externalConfigPath ? ` ${shellQuote(`--spring.config.additional-location=${target.externalConfigPath}`)}` : '';
  const jvmOptions = parseRuntimeArguments(target.jvmOptions, 'JVM 参数').map(shellQuote).join(' ');
  const managedNacosOptions = buildManagedNacosJvmOptions(target);
  const appArgs = parseRuntimeArguments(target.appArgs, '应用参数').map(shellQuote).join(' ');
  const command = `${shellQuote(javaBin)}${jvmOptions ? ` ${jvmOptions}` : ''}${managedNacosOptions ? ` ${managedNacosOptions}` : ''} -jar "$RUNTIME_JAR" ${shellQuote(`--server.port=${target.serverPort}`)}${profileArg}${configArg}${appArgs ? ` ${appArgs}` : ''}`;
  return `#!/usr/bin/env bash
set -u
ROOT=${shellQuote(paths.root)}
PID_FILE=${shellQuote(paths.pidFile)}
LOG_FILE=${shellQuote(paths.logFile)}
ENV_FILE=${shellQuote(paths.environmentFile)}
STOP_TIMEOUT=${Number(target.stopTimeoutSeconds || 30)}
KILL_GRACE=10
RUNTIME_JAR=${shellQuote(paths.currentRuntimeJar || path.posix.join(paths.currentLink, '.yuyan-runtime.jar'))}
[ -f "$RUNTIME_JAR" ] || RUNTIME_JAR=${shellQuote(paths.legacyCurrentJar || path.posix.join(paths.currentLink, 'app.jar'))}
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

read_pid() {
  [ -f "$PID_FILE" ] && tr -dc '0-9' < "$PID_FILE"
}

is_managed_pid() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
  [ -r "/proc/$pid/cmdline" ] || return 1
  local cmdline
  cmdline="$(tr '\\0' ' ' < "/proc/$pid/cmdline")"
  case "$cmdline" in
    *"$ROOT/current/.yuyan-runtime.jar"*|*"$ROOT/releases/"*"/.yuyan-runtime.jar"*|*"$ROOT/current/app.jar"*|*"$ROOT/releases/"*"/app.jar"*) return 0 ;;
    *) return 1 ;;
  esac
}

status_service() {
  local pid
  pid="$(read_pid)"
  if is_managed_pid "$pid"; then
    echo "RUNNING:$pid"
    return 0
  fi
  [ -f "$PID_FILE" ] && rm -f "$PID_FILE"
  echo "STOPPED"
  return 3
}

start_service() {
  if status_service >/dev/null 2>&1; then
    echo "ALREADY_RUNNING:$(read_pid)"
    return 0
  fi
  [ -f "$RUNTIME_JAR" ] || { echo "MISSING_JAR:$RUNTIME_JAR" >&2; return 1; }
  mkdir -p "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"
  cd "$ROOT"
  nohup ${command} >> "$LOG_FILE" 2>&1 &
  echo "$!" > "$PID_FILE"
  sleep 1
  status_service
}

stop_service() {
  local pid
  pid="$(read_pid)"
  if [ -z "$pid" ]; then
    echo "ALREADY_STOPPED"
    return 0
  fi
  if ! is_managed_pid "$pid"; then
    echo "REFUSE_UNMANAGED_PID:$pid" >&2
    return 2
  fi
  kill -TERM "$pid"
  local waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$STOP_TIMEOUT" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    local grace_waited=0
    while kill -0 "$pid" 2>/dev/null && [ "$grace_waited" -lt "$KILL_GRACE" ]; do
      sleep 1
      grace_waited=$((grace_waited + 1))
    done
  fi
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid"
    sleep 1
  fi
  rm -f "$PID_FILE"
  echo "STOPPED:$pid"
}

case "\${1:-status}" in
  start) start_service ;;
  stop) stop_service ;;
  restart) stop_service && start_service ;;
  status) status_service ;;
  *) echo "usage: $0 {start|stop|restart|status}" >&2; exit 2 ;;
esac
`;
}

/**
 * 生成 systemd unit。
 * @param {Object} target 部署目标
 * @param {Object} server 服务器
 * @param {Object} paths 远程路径
 * @returns {{unitName: string, unitPath: string, content: string}} unit
 */
function buildSystemdUnit(target, server, paths) {
  const unitName = `yuyan-${target.id}-${target.serviceName}.service`;
  const javaBin = path.posix.join(target.runtimeJavaHome, 'bin', 'java');
  const profileArg = target.springProfiles ? ` ${shellQuote(`--spring.profiles.active=${target.springProfiles}`)}` : '';
  const configArg = target.externalConfigPath ? ` ${shellQuote(`--spring.config.additional-location=${target.externalConfigPath}`)}` : '';
  const jvmOptions = parseRuntimeArguments(target.jvmOptions, 'JVM 参数').map(shellQuote).join(' ');
  const managedNacosOptions = buildManagedNacosJvmOptions(target);
  const appArgs = parseRuntimeArguments(target.appArgs, '应用参数').map(shellQuote).join(' ');
  const command = `RUNTIME_JAR=${shellQuote(paths.currentRuntimeJar)}; if [ ! -f "$RUNTIME_JAR" ]; then RUNTIME_JAR=${shellQuote(paths.legacyCurrentJar)}; fi; exec ${shellQuote(javaBin)}${jvmOptions ? ` ${jvmOptions}` : ''}${managedNacosOptions ? ` ${managedNacosOptions}` : ''} -jar "$RUNTIME_JAR" ${shellQuote(`--server.port=${target.serverPort}`)}${profileArg}${configArg}${appArgs ? ` ${appArgs}` : ''}`;
  return {
    unitName,
    unitPath: path.posix.join('/etc/systemd/system', unitName),
    content: `[Unit]
Description=Yuyan managed service ${target.serviceName}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${server.username}
WorkingDirectory=${paths.currentLink}
EnvironmentFile=-${paths.environmentFile}
ExecStart=/bin/bash -lc ${shellQuote(command)}
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=${Number(target.stopTimeoutSeconds || 30)}
StandardOutput=append:${paths.logFile}
StandardError=append:${paths.logFile}

[Install]
WantedBy=multi-user.target
`,
  };
}

/**
 * 检查远程 Java 并生成进程管理文件。
 * @param {Object} conn SSH 连接
 * @param {Object} context 后端上下文
 * @param {(level: string, message: string, stage?: string) => void} log 日志
 * @returns {Promise<{mode: 'pid'|'systemd', paths: Object, unitName: string, remoteJavaMajor: number}>} 运行控制器
 */
async function prepareRuntimeController(conn, context, log) {
  const { target, server, buildJdk, environment } = context;
  const paths = getBackendRuntimePaths(target);
  await execSsh(conn, `mkdir -p ${[paths.releasesDir, paths.configDir, paths.logsDir, paths.nasDir, paths.runDir, paths.binDir].map(shellQuote).join(' ')}`, { label: '初始化后端目录' });
  await execSsh(conn, buildBackendRootCompatibilityCommand(paths), { label: '初始化兼容目录' });
  const javaBin = path.posix.join(target.runtimeJavaHome, 'bin', 'java');
  const javaResult = await execSsh(conn, `${shellQuote(javaBin)} -version 2>&1`, { label: '检测服务器 Java' });
  const remoteJavaMajor = parseJavaMajorVersion(`${javaResult.stdout}\n${javaResult.stderr}`);
  if (!remoteJavaMajor) throw new Error(`无法识别服务器 Java 版本：${redactDeployLog(javaResult.stdout || javaResult.stderr)}`);
  const expectedJavaMajor = Number(buildJdk?.majorVersion || parseJavaMajorVersion(target.runtimeJavaVersion) || 0);
  if (expectedJavaMajor && remoteJavaMajor !== expectedJavaMajor) {
    throw new Error(`JDK 版本不匹配：目标要求 Java ${expectedJavaMajor}，服务器运行环境为 Java ${remoteJavaMajor}`);
  }
  log('success', `服务器 Java ${remoteJavaMajor} 检测通过`, 'validate');

  const credential = environment?.credential || {};
  const environmentValues = {
    JAVA_HOME: target.runtimeJavaHome,
    SERVER_PORT: target.serverPort,
    SPRING_PROFILES_ACTIVE: target.springProfiles || '',
    NACOS_SERVER_ADDR: normalizeNacosRuntimeAddress(target.nacosServerAddr),
    NACOS_NAMESPACE: target.nacosNamespace || '',
    NACOS_GROUP: target.nacosGroup || 'DEFAULT_GROUP',
    NACOS_USERNAME: credential.username || '',
    NACOS_PASSWORD: credential.password || '',
  };
  const environmentContent = `${Object.entries(environmentValues)
    .map(([key, value]) => `${key}=${shellQuote(String(value ?? ''))}`)
    .join('\n')}\n`;
  await writeRemoteContent(conn, paths.environmentFile, environmentContent, { mode: '600' });
  await writeRemoteContent(conn, paths.scriptPath, buildPidServiceScript(target, paths), { executable: true });
  let mode = target.processMode === 'systemd' ? 'systemd' : 'pid';
  let unitName = '';
  if (mode === 'systemd') {
    const sudo = await execSsh(conn, 'sudo -n true', { allowFailure: true, label: '检测免密 sudo' });
    if (sudo.code !== 0) {
      mode = 'pid';
      log('warn', '服务器不可免密 sudo，已回退为 PID 脚本模式', 'validate');
    } else {
      const unit = buildSystemdUnit(target, server, paths);
      unitName = unit.unitName;
      await writeRemoteContent(conn, unit.unitPath, unit.content, { sudo: true });
      await execSsh(conn, 'sudo -n systemctl daemon-reload', { label: '加载 systemd unit' });
      await execSsh(conn, `sudo -n systemctl enable ${shellQuote(unitName)}`, { label: '启用 systemd 服务' });
    }
  }
  return { mode, paths, unitName, remoteJavaMajor };
}

/**
 * 执行服务管理动作。
 * @param {Object} conn SSH 连接
 * @param {Object} controller 运行控制器
 * @param {'start'|'stop'|'restart'|'status'} action 动作
 * @returns {Promise<Object>} 命令结果
 */
async function runControllerAction(conn, controller, action) {
  if (controller.mode === 'systemd') {
    if (action === 'status') {
      return execSsh(conn, `sudo -n systemctl is-active ${shellQuote(controller.unitName)}`, { allowFailure: true, label: '查询服务状态' });
    }
    return execSsh(conn, `sudo -n systemctl ${action} ${shellQuote(controller.unitName)}`, { label: `${action} 服务` });
  }
  return execSsh(conn, `${shellQuote(controller.paths.scriptPath)} ${action}`, { allowFailure: action === 'status', label: `${action} 服务` });
}

/**
 * 检查目标服务端口是否已被占用。
 * @param {Object} conn SSH 连接
 * @param {number} port 服务端口
 * @returns {Promise<boolean>} 端口是否已被监听
 */
async function isRemotePortOccupied(conn, port) {
  const normalizedPort = Number(port || 0);
  const result = await execSsh(
    conn,
    `if command -v ss >/dev/null 2>&1; then ss -ltn | awk '{print $4}' | grep -Eq '[:.]${normalizedPort}$'; else exit 1; fi`,
    { allowFailure: true, label: '检查端口占用' }
  );
  return result.code === 0;
}

/**
 * 读取服务异常退出前的日志尾部。
 * @param {Object} conn SSH 连接
 * @param {Object} paths 后端运行目录
 * @param {number} lines 读取行数
 * @returns {Promise<string>} 已脱敏的日志尾部
 */
async function readRuntimeFailureLog(conn, paths, lines = 80) {
  const safeLines = Math.min(200, Math.max(20, Number(lines || 80)));
  const result = await execSsh(conn, `tail -n ${safeLines} ${shellQuote(paths.logFile)}`, {
    allowFailure: true,
    label: '读取启动失败日志',
  });
  return redactDeployLog(`${result.stdout || ''}${result.stderr || ''}`.trim());
}

/**
 * 根据命令输出解析服务状态。
 * @param {Object} controller 运行控制器
 * @param {Object} result 命令结果
 * @returns {'online'|'offline'|'error'|'unknown'} 状态
 */
function parseServiceStatus(controller, result) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (controller.mode === 'systemd') {
    if (output.includes('active') && !output.includes('inactive')) return 'online';
    if (['inactive', 'failed', 'deactivating'].some((item) => output.includes(item))) return output.includes('failed') ? 'error' : 'offline';
    return 'unknown';
  }
  if (output.includes('RUNNING:') || output.includes('ALREADY_RUNNING:')) return 'online';
  if (output.includes('STOPPED') || output.includes('ALREADY_STOPPED')) return 'offline';
  if (output.includes('REFUSE_UNMANAGED_PID')) return 'error';
  return 'unknown';
}

/**
 * 检查 Nacos TCP 地址。
 * @param {Object} conn SSH 连接
 * @param {Object} target 部署目标
 */
async function assertNacosAvailable(conn, target) {
  const address = String(target.nacosServerAddr || '').split(',')[0].trim();
  if (!address) return;
  const withoutScheme = address.replace(/^https?:\/\//i, '').split('/')[0];
  const [host, portText] = withoutScheme.split(':');
  const port = Number(portText || 8848);
  if (!/^[a-zA-Z0-9.-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Nacos 地址不合法');
  const result = await execSsh(conn, `timeout 3 bash -c ${shellQuote(`</dev/tcp/${host}/${port}`)}`, { allowFailure: true, label: '检测 Nacos' });
  if (result.code !== 0) throw new Error(`Nacos 不可达：${host}:${port}`);
}

/**
 * 可选校验当前服务已注册健康 Nacos 实例。
 * @param {Object} conn SSH 连接
 * @param {Object} target 部署目标
 * @param {Object|null} environment 共享环境及凭据
 */
async function assertNacosRegistration(conn, target, environment) {
  if (!target.requireNacosRegistration) return;
  const address = String(target.nacosServerAddr || '').split(',')[0].trim();
  if (!address) throw new Error('已启用 Nacos 注册校验，但未配置 Nacos 地址');
  const base = /^https?:\/\//i.test(address) ? address : `http://${address}`;
  let url;
  try {
    const parsed = new URL(base);
    parsed.pathname = '/nacos/v1/ns/instance/list';
    parsed.search = '';
    parsed.searchParams.set('serviceName', target.serviceName);
    parsed.searchParams.set('groupName', target.nacosGroup || 'DEFAULT_GROUP');
    if (target.nacosNamespace) parsed.searchParams.set('namespaceId', target.nacosNamespace);
    parsed.searchParams.set('healthyOnly', 'true');
    if (environment?.credential?.username) parsed.searchParams.set('username', environment.credential.username);
    if (environment?.credential?.password) parsed.searchParams.set('password', environment.credential.password);
    if (environment?.credential?.token) parsed.searchParams.set('accessToken', environment.credential.token);
    url = parsed.toString();
  } catch {
    throw new Error('Nacos 注册检查地址不合法');
  }
  const command = `response=$(curl -fsS --max-time 3 ${shellQuote(url)}) && printf %s "$response" | grep -Eq '"healthy"[[:space:]]*:[[:space:]]*true|"healthyCount"[[:space:]]*:[[:space:]]*[1-9]'`;
  const result = await execSsh(conn, command, { allowFailure: true, label: '校验 Nacos 服务注册' });
  if (result.code !== 0) throw new Error(`Nacos 未发现健康注册实例：${target.serviceName}`);
}

/**
 * 轮询远程 HTTP 健康状态。
 * @param {Object} conn SSH 连接
 * @param {Object} target 部署目标
 * @param {AbortSignal} signal 取消信号
 * @param {(level: string, message: string, stage?: string) => void} log 日志
 */
async function waitForRemoteHealth(conn, target, signal, log, environment = null) {
  const url = `http://127.0.0.1:${target.serverPort}${target.healthCheckPath || '/actuator/health'}`;
  const attempts = Math.max(1, Math.ceil(Number(target.startupTimeoutSeconds || 120) / 3));
  const command = `if command -v curl >/dev/null 2>&1; then curl -sS --max-time 3 -o /dev/null -w '%{http_code}' ${shellQuote(url)}; elif command -v wget >/dev/null 2>&1; then wget -q -T 3 -O /dev/null ${shellQuote(url)} && printf 200; else exit 127; fi`;
  let lastHttpStatus = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (signal?.aborted) throw new Error('任务已取消');
    const result = await execSsh(conn, command, { allowFailure: true, label: '健康检查' });
    const httpStatus = Number(String(result.stdout || '').trim().match(/\d{3}$/)?.[0] || 0);
    lastHttpStatus = httpStatus || lastHttpStatus;
    if (result.code === 0 && httpStatus >= 200 && httpStatus < 400) {
      log('success', `健康检查通过：${url}`, 'health');
      await assertNacosRegistration(conn, target, environment);
      if (target.requireNacosRegistration) log('success', `Nacos 注册检查通过：${target.serviceName}`, 'health');
      if (target.gatewayUrl && target.gatewayProbePath) {
        const gatewayUrl = `${String(target.gatewayUrl).replace(/\/$/, '')}/${String(target.gatewayProbePath).replace(/^\//, '')}`;
        const gatewayResult = await execSsh(conn, `curl -fsS --max-time 3 ${shellQuote(gatewayUrl)} >/dev/null`, { allowFailure: true, label: 'Gateway 探测' });
        if (gatewayResult.code !== 0) throw new Error(`服务本机健康，但 Gateway 路由不可达：${gatewayUrl}`);
        log('success', `Gateway 路由可达：${gatewayUrl}`, 'health');
      }
      return;
    }
    if (httpStatus >= 400 && httpStatus < 500 && ![408, 425, 429].includes(httpStatus)) {
      throw new Error(`健康检查地址返回 HTTP ${httpStatus}，请检查路径或访问权限：${url}`);
    }
    if (attempt === 1 || attempt % 5 === 0 || attempt === attempts) {
      const detail = httpStatus ? `HTTP ${httpStatus}` : '服务尚未接受连接';
      log('info', `健康检查等待中（${attempt}/${attempts}，${detail}）`, 'health');
    }
    if (attempt < attempts) await delay(3000, signal);
  }
  const runtimeLog = await readRuntimeFailureLog(conn, getBackendRuntimePaths(target), 60);
  const statusDetail = lastHttpStatus ? `，最后状态 HTTP ${lastHttpStatus}` : '';
  throw new Error(`服务未在 ${target.startupTimeoutSeconds || 120} 秒内通过健康检查${statusDetail}：${url}${runtimeLog ? `\n应用日志：\n${runtimeLog}` : ''}`);
}

/**
 * 获取远程部署锁。
 * @param {Object} conn SSH 连接
 * @param {Object} paths 远程路径
 */
async function acquireRemoteDeployLock(conn, paths) {
  const command = `if [ -d ${shellQuote(paths.lockDir)} ] && find ${shellQuote(paths.lockDir)} -maxdepth 0 -mmin +120 | grep -q .; then rm -rf ${shellQuote(paths.lockDir)}; fi; mkdir ${shellQuote(paths.lockDir)}`;
  await execSsh(conn, command, { label: '获取远程部署锁' });
}

/**
 * 释放远程部署锁。
 * @param {Object} conn SSH 连接
 * @param {Object} paths 远程路径
 */
async function releaseRemoteDeployLock(conn, paths) {
  await execSsh(conn, `rm -rf ${shellQuote(paths.lockDir)}`, { allowFailure: true, label: '释放远程部署锁' });
}

/**
 * 上传并校验后端版本。
 * @param {Object} conn SSH 连接
 * @param {Object} release 版本信息
 * @param {string} localJarPath 本地 Jar
 * @param {string} checksum SHA-256
 */
async function uploadBackendRelease(conn, release, localJarPath, checksum) {
  const jarName = path.posix.basename(release.jarName);
  if (!jarName.toLowerCase().endsWith('.jar')) throw new Error('构建产物文件名必须以 .jar 结尾');
  const tempPath = path.posix.join(release.releaseDir, `.${jarName}.part`);
  const jarPath = path.posix.join(release.releaseDir, jarName);
  await execSsh(conn, `mkdir -p ${shellQuote(release.releaseDir)}`, { label: '创建版本目录' });
  await uploadFile(conn, localJarPath, tempPath);
  const remoteHash = await execSsh(conn, `if command -v sha256sum >/dev/null 2>&1; then sha256sum ${shellQuote(tempPath)} | awk '{print $1}'; else shasum -a 256 ${shellQuote(tempPath)} | awk '{print $1}'; fi`, { label: '校验远程 Jar' });
  if (remoteHash.stdout.trim().toLowerCase() !== checksum.toLowerCase()) throw new Error('远程 Jar SHA-256 与本地不一致');
  await execSsh(conn, `mv ${shellQuote(tempPath)} ${shellQuote(jarPath)}`, { label: '确认版本产物' });
  await execSsh(conn, buildBackendReleaseCompatibilityCommand(release.paths, release.releaseDir, release.jarName), { label: '创建版本兼容链接' });
}

/**
 * 清理超过保留数量的后端版本。
 * @param {Object} conn SSH 连接
 * @param {number} targetId 目标 ID
 * @param {number[]} protectedIds 保护版本 ID
 */
async function pruneBackendReleases(conn, targetId, protectedIds = []) {
  const releases = await listBackendReleases(targetId);
  const protectedSet = new Set(protectedIds.filter(Boolean));
  let kept = 0;
  for (const release of releases) {
    if (protectedSet.has(release.id) || release.isCurrent || kept < DEFAULT_BACKEND_RELEASE_KEEP) {
      kept += 1;
      continue;
    }
    await execSsh(conn, `rm -rf ${shellQuote(release.releaseDir)}`, { allowFailure: true, label: '清理旧版本' });
    await updateBackendReleaseStatus(release.id, 'pruned');
  }
}

/**
 * 执行后端版本化发布。
 * @param {number} targetId 目标 ID
 * @param {Object} payload 发布参数
 * @param {Object} emit 进度输出器
 * @returns {Promise<Object>} 发布记录
 */
export async function deployBackendTarget(targetId, payload, emit) {
  const context = await getBackendContext(targetId);
  const { target, server, buildJdk } = context;
  const branch = payload.branch || target.defaultBranch;
  const operator = String(payload.operator || '').trim() || '未知操作人';
  const signal = payload.signal;
  const logs = [];
  const log = (level, message, stage = '') => {
    const safeMessage = redactDeployLog(message);
    logs.push({ level, message: safeMessage, stage, timestamp: new Date().toISOString() });
    emit?.log(level, safeMessage, stage);
  };
  const stage = (key, percent, message, detail = '') => emit?.stage(key, percent, message, detail);
  const record = await createRecord({
    targetId: target.id,
    projectId: target.projectId,
    projectName: target.projectName,
    envName: target.envName || '测试',
    branch,
    action: 'deploy',
    status: 'running',
    operator,
    logs,
  });
  let backendRelease = null;
  let previousRelease = null;
  let controller = null;
  let activationStarted = false;
  let restoredPrevious = false;
  let commitSha = '';
  let commitMessage = '';
  let commitAuthor = '';
  try {
    previousRelease = await getCurrentBackendRelease(target.id);
    await updateBackendServiceStatus(target.id, { status: 'deploying', output: '后端版本构建与发布中' });
    stage('validate', 5, '后端发布预检', '检查 JDK、路径、端口和运行模式');
    log('info', `操作人 ${operator} 发起后端发布`, 'audit');
    stage('clone', 15, '拉取代码', `${target.projectName}#${branch}`);
    const workspace = await syncBackendWorkspace({ target, branch, gitlabToken: payload.gitlabToken || '', signal, log });
    ({ commitSha, commitMessage, commitAuthor } = workspace);

    const env = { JAVA_HOME: buildJdk.homePath, PATH: `${path.join(buildJdk.homePath, 'bin')}:${process.env.PATH}` };
    if (buildJdk.isDownwardCompatible) {
      log('warning', `[WARN] 本地未找到完全匹配的 Java ${buildJdk.originalRequiredVersion}，已向下兼容使用 ${buildJdk.name} 进行构建`, 'build');
    }
    await withBackendBuildSlot(async () => {
      if (target.installCommand) {
        stage('install', 28, 'Maven 仓库预热', target.installCommand);
        await runBackendLocalCommand(target.installCommand, {
          cwd: workspace.repoDir,
          env,
          signal,
          label: 'Maven 预热',
          onLog: (level, message) => log(level, message, 'install'),
        });
      }
      stage('build', 46, '构建后端 Jar', target.buildCommand);
      await runBackendLocalCommand(target.buildCommand, {
        cwd: workspace.repoDir,
        env,
        signal,
        label: 'Maven 构建',
        onLog: (level, message) => log(level, message, 'build'),
      });
    });
    const artifact = await resolveBackendArtifact(workspace.repoDir, target.artifactPattern || target.artifactDir);
    const checksum = await createFileSha256(artifact.jarPath);
    const publishedJarName = normalizePublishedJarName(artifact.jarName);
    const releaseName = createBackendReleaseName();
    const paths = getBackendRuntimePaths(target);
    const releaseDir = path.posix.join(paths.releasesDir, releaseName);
    log('success', `构建完成：${artifact.jarName} (${checksum.slice(0, 12)})`, 'build');
    if (publishedJarName !== artifact.jarName) log('info', `发布文件名：${publishedJarName}`, 'build');

    await withServerActivationLock(server.id, async () => withSsh(server, async (conn) => {
      controller = await prepareRuntimeController(conn, context, log);
      await assertNacosAvailable(conn, target);
      await acquireRemoteDeployLock(conn, controller.paths);
      try {
        const localStat = await fsStatSafe(artifact.jarPath);
        const disk = await execSsh(conn, `df -Pk ${shellQuote(controller.paths.root)} | awk 'NR==2 {print $4}'`, { label: '检查磁盘空间' });
        const availableBytes = Number(disk.stdout.trim() || 0) * 1024;
        if (localStat && availableBytes < localStat.size * 2 + 100 * 1024 * 1024) throw new Error('服务器磁盘空间不足，至少需要 Jar 大小两倍加 100MB');

        stage('upload', 66, '上传版本产物', releaseDir);
        await uploadBackendRelease(conn, {
          releaseDir,
          jarName: publishedJarName,
          paths: controller.paths,
        }, artifact.jarPath, checksum);
        backendRelease = await createBackendRelease({
          targetId: target.id,
          recordId: record.id,
          releaseName,
          releaseDir,
          jarName: publishedJarName,
          artifactSha256: checksum,
          commitSha,
        });

        const beforeStatus = await runControllerAction(conn, controller, 'status');
        if (parseServiceStatus(controller, beforeStatus) === 'offline') {
          const portCheck = await execSsh(conn, `if command -v ss >/dev/null 2>&1; then ss -ltn | awk '{print $4}' | grep -Eq '[:.]${target.serverPort}$'; else exit 1; fi`, { allowFailure: true, label: '检查端口占用' });
          if (portCheck.code === 0) throw new Error(`端口 ${target.serverPort} 已被非当前服务占用`);
        }

        stage('stop', 78, '停止旧服务', '优雅停止当前版本');
        activationStarted = true;
        await runControllerAction(conn, controller, 'stop');
        await execSsh(conn, `ln -sfn ${shellQuote(releaseDir)} ${shellQuote(controller.paths.currentLink)}`, { label: '切换 current 版本' });
        stage('start', 88, '启动新服务', releaseName);
        await runControllerAction(conn, controller, 'start');
        stage('health', 94, '验证服务健康', `127.0.0.1:${target.serverPort}`);
        await waitForRemoteHealth(conn, target, signal, log, context.environment);
        await activateBackendRelease(backendRelease.id);
        await updateBackendServiceStatus(target.id, { status: 'online', output: `${controller.mode} · Java ${controller.remoteJavaMajor}` });
        await pruneBackendReleases(conn, target.id, [backendRelease.id, previousRelease?.id]);
      } catch (error) {
        if (backendRelease) await updateBackendReleaseStatus(backendRelease.id, 'failed');
        if (previousRelease && controller) {
          log('warn', '新版本启动失败，正在恢复上一版本', 'rollback');
          await runControllerAction(conn, controller, 'stop').catch(() => {});
          await execSsh(conn, `ln -sfn ${shellQuote(previousRelease.releaseDir)} ${shellQuote(controller.paths.currentLink)}`, { label: '恢复上一版本' });
          await runControllerAction(conn, controller, 'start');
          await waitForRemoteHealth(conn, target, signal, log, context.environment);
          await activateBackendRelease(previousRelease.id);
          restoredPrevious = true;
          log('success', '上一版本已恢复并通过健康检查', 'rollback');
        }
        throw error;
      } finally {
        await releaseRemoteDeployLock(conn, controller.paths);
      }
    }));

    stage('finish', 100, '后端发布完成', `${target.projectName} 已在线`);
    const successRecord = await updateRecord(record.id, {
      status: 'success',
      commitSha,
      commitMessage,
      commitAuthor,
      releasePath: backendRelease.releaseDir,
      backupPath: previousRelease?.releaseDir || '',
      restoredRecordId: record.id,
      backupRecordId: previousRelease?.recordId || 0,
      logs,
      finishedAt: new Date().toISOString(),
    });
    emit?.result(successRecord);
    return successRecord;
  } catch (error) {
    log('error', error instanceof Error ? error.message : String(error), 'error');
    const previousStillOnline = Boolean(previousRelease && (!activationStarted || restoredPrevious));
    await updateBackendServiceStatus(target.id, { status: previousStillOnline ? 'online' : 'error', output: error instanceof Error ? error.message : String(error) });
    const failed = await updateRecord(record.id, {
      status: signal?.aborted ? 'stopped' : 'failed',
      commitSha,
      commitMessage,
      commitAuthor,
      releasePath: backendRelease?.releaseDir || '',
      backupPath: previousRelease?.releaseDir || '',
      logs,
      finishedAt: new Date().toISOString(),
    });
    if (signal?.aborted) emit?.result(failed);
    else emit?.error(error instanceof Error ? error.message : String(error), 'error');
    if (signal?.aborted) return failed;
    throw error;
  }
}

/**
 * 安全读取文件信息。
 * @param {string} filePath 文件路径
 * @returns {Promise<import('node:fs').Stats|null>} 文件信息
 */
async function fsStatSafe(filePath) {
  const fs = await import('node:fs/promises');
  return fs.stat(filePath).catch(() => null);
}

/**
 * 查询后端服务真实状态。
 * @param {number} targetId 目标 ID
 * @returns {Promise<Object>} 状态
 */
export async function getBackendServiceStatus(targetId) {
  const context = await getBackendContext(targetId, { requireBuild: false });
  return withSsh(context.server, async (conn) => {
    const controller = await prepareRuntimeController(conn, context, () => {});
    const result = await runControllerAction(conn, controller, 'status');
    const status = parseServiceStatus(controller, result);
    const output = redactDeployLog(`${result.stdout || ''}${result.stderr || ''}`.trim());
    let nacosStatus = context.target.nacosServerAddr ? 'online' : 'unconfigured';
    let nacosOutput = '';
    if (context.target.nacosServerAddr) {
      try {
        await assertNacosAvailable(conn, context.target);
        nacosOutput = 'Nacos TCP 连接正常';
      } catch (error) {
        nacosStatus = 'offline';
        nacosOutput = error instanceof Error ? error.message : String(error);
      }
    }
    if (context.target.environmentId) {
      await updateDeployEnvironmentStatus(context.target.environmentId, nacosStatus === 'unconfigured' ? 'unknown' : nacosStatus, nacosOutput);
    }
    await updateBackendServiceStatus(targetId, { status, output });
    return {
      targetId: Number(targetId),
      status,
      output,
      processMode: controller.mode,
      directUrl: context.target.directUrl,
      gatewayUrl: context.target.gatewayUrl || '',
      nacosConsoleUrl: context.target.nacosConsoleUrl || '',
      nacosStatus,
      checkedAt: new Date().toISOString(),
    };
  });
}

/**
 * 执行后端服务动作。
 * @param {number} targetId 目标 ID
 * @param {'start'|'stop'|'restart'} action 动作
 * @param {Object} options 选项
 * @returns {Promise<Object>} 状态
 */
export async function runBackendServiceAction(targetId, action, options = {}) {
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('不支持的服务操作');
  const context = await getBackendContext(targetId, { requireBuild: false });
  await updateBackendServiceStatus(targetId, { status: action === 'stop' ? 'stopping' : 'starting', output: `正在${action}服务` });
  try {
    return await withServerActivationLock(context.server.id, async () => withSsh(context.server, async (conn) => {
      const controller = await prepareRuntimeController(conn, context, options.log || (() => {}));
      const beforeResult = await runControllerAction(conn, controller, 'status');
      const beforeStatus = parseServiceStatus(controller, beforeResult);
      if (action !== 'stop' && beforeStatus !== 'online' && await isRemotePortOccupied(conn, context.target.serverPort)) {
        throw new Error(`端口 ${context.target.serverPort} 已被非当前受控服务占用，请停止原服务或为测试目标更换端口`);
      }
      if (action !== 'stop') await assertNacosAvailable(conn, context.target);
      await runControllerAction(conn, controller, action);
      let result = await runControllerAction(conn, controller, 'status');
      let status = parseServiceStatus(controller, result);
      if (action !== 'stop' && status !== 'online') {
        const runtimeLog = await readRuntimeFailureLog(conn, controller.paths);
        const statusOutput = redactDeployLog(`${result.stdout || ''}${result.stderr || ''}`.trim()) || '受控进程已退出';
        throw new Error(`服务进程启动后未保持运行：${statusOutput}${runtimeLog ? `\n应用日志：\n${runtimeLog}` : ''}`);
      }
      if (action === 'stop' && status !== 'offline') {
        throw new Error(`服务停止后状态异常：${status}`);
      }
      if (action !== 'stop') {
        options.log?.('success', `受控服务进程已${action === 'restart' ? '重启' : '启动'}：${status}`, action);
      }
      const output = redactDeployLog(`${result.stdout || ''}${result.stderr || ''}`.trim());
      await updateBackendServiceStatus(targetId, { status, output });
      return { targetId, action, status, output, processMode: controller.mode, checkedAt: new Date().toISOString() };
    }));
  } catch (error) {
    await updateBackendServiceStatus(targetId, { status: 'error', output: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/**
 * 获取后端服务尾部日志。
 * @param {number} targetId 目标 ID
 * @param {number} lines 行数
 * @returns {Promise<{content: string}>} 日志
 */
export async function readBackendServiceLogs(targetId, lines = 500) {
  const context = await getBackendContext(targetId, { requireBuild: false });
  const paths = getBackendRuntimePaths(context.target);
  return withSsh(context.server, async (conn) => {
    const safeLines = Math.min(5000, Math.max(20, Number(lines || 500)));
    const result = await execSsh(conn, `tail -n ${safeLines} ${shellQuote(paths.logFile)}`, { allowFailure: true, label: '读取服务日志' });
    return { content: redactDeployLog(`${result.stdout || ''}${result.stderr || ''}`), lines: safeLines, path: paths.logFile };
  });
}

/**
 * 执行后端记录回滚或撤销回滚。
 * @param {number} recordId 来源记录 ID
 * @param {Object} payload 操作参数
 * @param {Object} emit 进度输出器
 * @param {'rollback'|'undoRollback'} action 动作
 * @returns {Promise<Object>} 新记录
 */
export async function restoreBackendRecord(recordId, payload, emit, action = 'rollback') {
  const sourceRecord = await getRecord(recordId);
  if (!sourceRecord?.backupRecordId) throw new Error('该发布记录没有可恢复的上一版本');
  const targetRelease = await getBackendReleaseByRecordId(sourceRecord.backupRecordId);
  if (!targetRelease || targetRelease.status === 'pruned') throw new Error('目标后端版本不存在或已清理');
  const context = await getBackendContext(sourceRecord.targetId, { requireBuild: false });
  const currentRelease = await getCurrentBackendRelease(sourceRecord.targetId);
  if (!currentRelease) throw new Error('当前后端版本不存在');
  const operator = String(payload.operator || '').trim() || '未知操作人';
  const logs = [];
  const log = (level, message, stage = '') => {
    const safeMessage = redactDeployLog(message);
    logs.push({ level, message: safeMessage, stage, timestamp: new Date().toISOString() });
    emit?.log(level, safeMessage, stage);
  };
  const record = await createRecord({
    targetId: context.target.id,
    projectId: context.target.projectId,
    projectName: context.target.projectName,
    envName: context.target.envName,
    branch: `${action === 'undoRollback' ? 'undo-rollback' : 'rollback'}-${sourceRecord.id}`,
    action,
    sourceRecordId: sourceRecord.id,
    restoredRecordId: targetRelease.recordId,
    backupRecordId: currentRelease.recordId,
    status: 'running',
    operator,
    logs,
  });
  let activationStarted = false;
  let restoredCurrent = false;
  try {
    await updateBackendServiceStatus(context.target.id, { status: 'deploying', output: '正在切换后端版本' });
    emit?.stage('rollback', 30, action === 'undoRollback' ? '撤销后端回滚' : '回滚后端版本', targetRelease.releaseName);
    await withServerActivationLock(context.server.id, async () => withSsh(context.server, async (conn) => {
      const controller = await prepareRuntimeController(conn, context, log);
      await acquireRemoteDeployLock(conn, controller.paths);
      try {
        activationStarted = true;
        await runControllerAction(conn, controller, 'stop');
        await execSsh(conn, `ln -sfn ${shellQuote(targetRelease.releaseDir)} ${shellQuote(controller.paths.currentLink)}`, { label: '切换回滚版本' });
        await runControllerAction(conn, controller, 'start');
        await waitForRemoteHealth(conn, context.target, payload.signal, log, context.environment);
        await activateBackendRelease(targetRelease.id);
      } catch (error) {
        await runControllerAction(conn, controller, 'stop').catch(() => {});
        await execSsh(conn, `ln -sfn ${shellQuote(currentRelease.releaseDir)} ${shellQuote(controller.paths.currentLink)}`, { label: '恢复回滚前版本' });
        await runControllerAction(conn, controller, 'start');
        await waitForRemoteHealth(conn, context.target, payload.signal, log, context.environment);
        await activateBackendRelease(currentRelease.id);
        restoredCurrent = true;
        throw error;
      } finally {
        await releaseRemoteDeployLock(conn, controller.paths);
      }
    }));
    const success = await updateRecord(record.id, {
      status: 'success',
      commitSha: targetRelease.commitSha,
      releasePath: targetRelease.releaseDir,
      backupPath: currentRelease.releaseDir,
      restoredRecordId: targetRelease.recordId,
      backupRecordId: currentRelease.recordId,
      logs,
      finishedAt: new Date().toISOString(),
    });
    await updateBackendServiceStatus(context.target.id, { status: 'online', output: `当前版本 ${targetRelease.releaseName}` });
    emit?.stage('finish', 100, action === 'undoRollback' ? '撤销回滚完成' : '后端回滚完成', targetRelease.releaseName);
    emit?.result(success);
    return success;
  } catch (error) {
    log('error', error instanceof Error ? error.message : String(error), 'error');
    await updateRecord(record.id, { status: 'failed', logs, finishedAt: new Date().toISOString() });
    await updateBackendServiceStatus(context.target.id, {
      status: !activationStarted || restoredCurrent ? 'online' : 'error',
      output: error instanceof Error ? error.message : String(error),
    });
    emit?.error(error instanceof Error ? error.message : String(error), 'rollback');
    throw error;
  }
}
