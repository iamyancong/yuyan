/** 部署根目录候选服务。 */

import path from 'node:path';
import { getServerWithCredential, listTargets } from './deploy-store.mjs';
import { listRemoteApplicationDirectories, withSsh } from './ssh-service.mjs';

/** 接口最多返回的部署根目录候选数。 */
const MAX_DEPLOY_ROOT_OPTIONS = 200;

/**
 * 标准化绝对 POSIX 路径。
 * @param {string} value - 原始路径
 * @returns {string} 标准化路径
 */
function normalizeAbsolutePath(value) {
  const normalized = path.posix.normalize(String(value || '').trim().replace(/\\/g, '/'));
  return normalized.startsWith('/') ? normalized.replace(/\/$/, '') || '/' : '';
}

/**
 * 从部署路径模板解析可扫描的应用根目录。
 * @param {string} template - 部署路径或含 appName 的模板
 * @returns {string} 应用根目录
 */
export function resolveDeployRootTemplate(template) {
  const normalized = normalizeAbsolutePath(template);
  if (!normalized) throw new Error('服务器部署根目录必须是绝对路径');
  const segments = normalized.split('/').filter(Boolean);
  const placeholderIndex = segments.indexOf('{appName}');
  const rootSegments = placeholderIndex >= 0 ? segments.slice(0, placeholderIndex) : segments;
  if (placeholderIndex >= 0 && placeholderIndex !== segments.length - 1) {
    throw new Error('部署根目录模板仅支持以 {appName} 作为最后一级目录');
  }
  if (rootSegments.length < 2) {
    throw new Error('服务器部署根目录范围过宽，请至少配置两级绝对路径');
  }
  return `/${rootSegments.join('/')}`;
}

/**
 * 根据服务器和 Nginx 实例解析前端应用根目录。
 * @param {Object} server - 服务器配置
 * @param {number} nginxInstanceId - Nginx 实例 ID
 * @returns {{configuredRoot: string, nginxInstanceId: number}} 根目录上下文
 */
export function resolveServerDeployRoot(server, nginxInstanceId = 0) {
  const instances = Array.isArray(server?.nginxInstances) ? server.nginxInstances : [];
  const requestedId = Number(nginxInstanceId || 0);
  const instance = requestedId
    ? instances.find((item) => Number(item.id) === requestedId)
    : instances.find((item) => Number(item.id) === Number(server?.defaultNginxInstanceId || 0)) || instances[0];
  if (requestedId && !instance) throw new Error('所选 Nginx 实例不存在或不属于当前服务器');
  const template = instance?.instanceType === 'managed'
    ? instance.htmlRoot || instance.defaultDeployRoot || server?.defaultDeployRoot
    : instance?.defaultDeployRoot || server?.defaultDeployRoot;
  if (!String(template || '').trim()) {
    throw new Error('当前服务器或 Nginx 实例未配置前端部署根目录');
  }
  return {
    configuredRoot: resolveDeployRootTemplate(template),
    nginxInstanceId: Number(instance?.id || 0),
  };
}

/**
 * 将服务器应用目录与部署目标占用信息合并。
 * @param {string} configuredRoot - 服务器应用根目录
 * @param {{rootHasIndex: boolean, directories: Array<{name: string, path: string}>, truncated: boolean}} scanResult - SFTP 扫描结果
 * @param {Object[]} targets - 当前服务器已有部署目标
 * @param {number} excludeTargetId - 编辑时排除的目标 ID
 * @returns {{configuredRoot: string, truncated: boolean, items: Object[]}} 下拉候选
 */
export function decorateDeployRootOptions(configuredRoot, scanResult, targets = [], excludeTargetId = 0) {
  const occupancy = new Map();
  const configuredTargetPaths = new Set();
  targets.forEach((target) => {
    const deployRoot = normalizeAbsolutePath(target.deployRoot);
    if (!deployRoot) return;
    if (deployRoot === configuredRoot || path.posix.dirname(deployRoot) === configuredRoot) {
      configuredTargetPaths.add(deployRoot);
    }
    if (Number(target.id) === Number(excludeTargetId || 0)) return;
    const entries = occupancy.get(deployRoot) || [];
    entries.push({
      targetId: Number(target.id),
      projectName: String(target.projectName || target.projectPath || `项目 ${target.projectId}`),
      branch: String(target.defaultBranch || ''),
      envName: String(target.envName || ''),
    });
    occupancy.set(deployRoot, entries);
  });

  const rawItems = [
    {
      kind: 'root',
      name: path.posix.basename(configuredRoot) || configuredRoot,
      path: configuredRoot,
      exists: true,
      hasIndexHtml: Boolean(scanResult.rootHasIndex),
    },
    ...scanResult.directories.map((item) => ({
      kind: 'application',
      name: item.name,
      path: normalizeAbsolutePath(item.path),
      exists: true,
      hasIndexHtml: true,
    })),
  ];
  const existingPaths = new Set(rawItems.map((item) => item.path));
  configuredTargetPaths.forEach((targetPath) => {
    if (existingPaths.has(targetPath)) return;
    rawItems.push({
      kind: targetPath === configuredRoot ? 'root' : 'application',
      name: path.posix.basename(targetPath) || targetPath,
      path: targetPath,
      exists: false,
      hasIndexHtml: false,
    });
  });
  const items = rawItems.map((item, index) => {
    const occupiedBy = occupancy.get(item.path) || [];
    return { ...item, occupied: occupiedBy.length > 0, occupiedBy, index };
  });
  items.sort((left, right) => {
    const leftPriority = left.kind === 'root' ? 0 : configuredTargetPaths.has(left.path) ? 1 : 2;
    const rightPriority = right.kind === 'root' ? 0 : configuredTargetPaths.has(right.path) ? 1 : 2;
    return leftPriority - rightPriority || left.index - right.index;
  });
  const truncated = Boolean(scanResult.truncated || items.length > MAX_DEPLOY_ROOT_OPTIONS);
  return {
    configuredRoot,
    truncated,
    items: items.slice(0, MAX_DEPLOY_ROOT_OPTIONS).map(({ index: _index, ...item }) => item),
  };
}

/**
 * 查询服务器前端部署根目录候选。
 * @param {number} serverId - 服务器 ID
 * @param {{nginxInstanceId?: number, excludeTargetId?: number}} options - 查询参数
 * @param {{getServer?: Function, getTargets?: Function, withConnection?: Function, scanDirectories?: Function}} dependencies - 可替换测试依赖
 * @returns {Promise<{configuredRoot: string, nginxInstanceId: number, truncated: boolean, items: Object[]}>} 候选结果
 */
export async function listDeployRootOptions(serverId, options = {}, dependencies = {}) {
  const getServer = dependencies.getServer || getServerWithCredential;
  const getTargets = dependencies.getTargets || listTargets;
  const withConnection = dependencies.withConnection || withSsh;
  const scanDirectories = dependencies.scanDirectories || listRemoteApplicationDirectories;
  const server = await getServer(serverId);
  if (!server) throw new Error('部署服务器不存在');
  const context = resolveServerDeployRoot(server, options.nginxInstanceId);
  const [scanResult, targets] = await Promise.all([
    withConnection(server, (conn) => scanDirectories(conn, context.configuredRoot, {
      limit: 200,
      timeoutMs: 8_000,
      concurrency: 8,
    })),
    getTargets({ serverId, projectType: 'frontend' }),
  ]);
  return {
    ...decorateDeployRootOptions(context.configuredRoot, scanResult, targets, options.excludeTargetId),
    nginxInstanceId: context.nginxInstanceId,
  };
}
