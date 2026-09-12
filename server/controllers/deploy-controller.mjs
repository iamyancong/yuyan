/**
 * 独立服务器部署控制器
 * @description 处理服务器配置、部署目标、发布、回滚和 Nginx 配置文件接口
 */

import {
  createServer,
  createTarget,
  createNginxInstance,
  deleteNginxInstance,
  deleteServer,
  deleteTarget,
  getRecord,
  getServerWithCredential,
  listNginxInstances,
  listRecords,
  listServers,
  reorderServers,
  listTargets,
  listTargetRuntimeIndex,
  updateNginxInstance,
  updateServer,
  updateTarget,
  closeDeployDb,
  getDeployDb,
  listJdks,
  getJdk,
  createJdk,
  updateJdk,
  deleteJdk,
  createPersistentDeployTask,
  updatePersistentDeployTask,
  getLatestOpenApiArtifact,
  getOpenApiArtifact,
  listServerJavaRuntimes,
  createServerJavaRuntime,
  deleteServerJavaRuntime,
  listDeployEnvironments,
  createDeployEnvironment,
  updateDeployEnvironment,
  deleteDeployEnvironment,
} from '../services/deploy-store.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';
import { DEPLOY_DB_PATH } from '../config/constants.mjs';
import { endArchiveSseWithError } from '../services/archive-sse.mjs';

import {
  deployTarget,
  readNginxConfig,
  rollbackRecord,
  saveNginxConfig,
  testServer,
  testTargetNginx,
  undoRollbackRecord,
} from '../services/deploy-service.mjs';
import {
  getNextNginxRuntimePort,
  getNextNginxInstancePort,
  getNginxInstanceArchiveSites,
  getNginxInstanceStatus,
  getNginxRuntimeStatus,
  initializeNginxInstanceRuntime,
  initializeNginxRuntime,
  runNginxInstanceAction,
  runNginxRuntimeAction,
  streamNginxInstanceArchive,
  saveNginxInstanceArchiveToPath,
  syncTargetNginxSite,
} from '../services/nginx-runtime-service.mjs';
import {
  buildPublishedAssetUrl,
  getManifestAsset,
  isNewerAppVersion,
  normalizeUpdateArch,
  normalizeUpdateChannel,
  normalizeUpdatePlatform,
  readPublishedUpdateManifest,
  selectLatestCompatibleRelease,
  validateManifestAsset,
} from '../services/app-update-service.mjs';
import { updateAssetCacheManager } from '../services/app-update-cache-service.mjs';
import {
  fetchGithubAppReleases,
  fetchGithubReleaseUpdater,
  mapGithubAssetToCacheAsset,
} from '../services/app-update-release-service.mjs';
import { generateTargetOpenApi, inspectBackendTarget } from '../services/backend-project-service.mjs';
import {
  getBackendServiceStatus,
  readBackendServiceLogs,
  runBackendServiceAction,
} from '../services/backend-runtime-service.mjs';
import {
  scanServerJavaRuntimes,
  scanLocalBuildJdks,
  testBuildJdk,
  testServerJavaRuntime,
} from '../services/backend-toolchain-service.mjs';
import { listActiveCentralDeployOperations } from '../services/artifact-job-service.mjs';
import { mergeDeployRuntimeSnapshots } from '../services/deploy-runtime-snapshot-service.mjs';
import { listDeployRootOptions } from '../services/deploy-root-options-service.mjs';
import { discoverServerNginx } from '../services/nginx-discovery-service.mjs';

/** GitHub 托管仓库名（主库或 Fork 库） */
const GITHUB_REPO = process.env.GITHUB_REPOSITORY || 'ycwang-dev/yuyan';

/** 发布任务停止错误 */
class DeployStoppedError extends Error {
  /**
   * 创建发布任务停止错误。
   * @param {string} message - 错误消息
   */
  constructor(message = '发布任务已停止') {
    super(message);
    this.name = 'DeployStoppedError';
    this.code = 'DEPLOY_STOPPED';
  }
}

/** 同时运行的发布/回滚任务上限 */
const MAX_RUNNING_DEPLOY_TASKS = 5;

/** 发布停止前允许中断的阶段 */
const STOPPABLE_DEPLOY_STAGE_KEYS = new Set(['validate', 'clone', 'install', 'build', 'openapi']);

/** 当前进程内正在执行的部署目标任务 */
const deployTasksByTargetId = new Map();

/** 关闭服务时等待部署任务收口的最长时间 */
const DEPLOY_SHUTDOWN_GRACE_MS = 2500;

/**
 * 创建部署目标任务。
 * @param {number} targetId - 部署目标 ID
 * @param {'deploy'|'rollback'|'undoRollback'|'openapi'|'start'|'stop'|'restart'} action - 任务类型
 * @param {Object} body - 请求体
 * @returns {Object} 任务上下文
 */
async function createDeployTask(targetId, action, body = {}) {
  const operator = String(body?.operator || '').trim() || '未知操作人';
  const startedAt = new Date().toISOString();
  const persistent = await createPersistentDeployTask({ targetId, action, operator, startedAt });
  return {
    targetId: Number(targetId),
    action,
    operator,
    startedAt,
    persistentId: persistent.id,
    controller: new AbortController(),
    events: [],
    subscribers: new Set(),
    currentStage: 'validate',
    completed: false,
    result: null,
    error: null,
    promise: null,
  };
}

/**
 * 获取任务序列化快照。
 * @param {Object} task - 任务上下文
 * @returns {Object} 快照
 */
function serializeDeployTask(task) {
  return {
    targetId: task.targetId,
    action: task.action,
    operator: task.operator,
    startedAt: task.startedAt,
    currentStage: task.currentStage,
    running: !task.completed,
    result: task.result,
    error: task.error,
    events: task.events,
    maxConcurrent: MAX_RUNNING_DEPLOY_TASKS,
    runningCount: deployTasksByTargetId.size,
  };
}

/** 将进程内任务映射为列表页使用的轻量运行态快照。 */
function serializeDeployTaskRuntime(task) {
  const latestStage = [...task.events].reverse().find((event) => event.type === 'stage');
  return {
    ...serializeDeployTask(task),
    events: latestStage ? [latestStage] : [],
  };
}

/**
 * 写入一个进度事件。
 * @param {Object} res - Express 响应对象
 * @param {Object} event - 进度事件
 */
function writeProgressEvent(res, event) {
  try {
    if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
  } catch {
  }
}

/**
 * 设置流式响应头。
 * @param {Object} res - Express 响应对象
 */
function prepareProgressStream(res) {
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

/**
 * 创建任务进度输出器。
 * @param {Object} task - 任务上下文
 * @returns {Object} 输出器
 */
function createProgressEmitter(task) {
  const write = (payload) => {
    const event = {
      timestamp: new Date().toISOString(),
      ...payload,
    };
    if (event.type === 'stage') task.currentStage = event.stage;
    if (event.type === 'result') task.result = event.data;
    if (event.type === 'error') task.error = event.message;
    task.events.push(event);
    task.subscribers.forEach((res) => writeProgressEvent(res, event));
    if (event.type === 'stage') {
      void updatePersistentDeployTask(task.persistentId, { stage: event.stage, percent: event.percent });
    } else if (event.type === 'result') {
      const resultRef = event.data?.id ? String(event.data.id) : '';
      void updatePersistentDeployTask(task.persistentId, { resultRef, logPath: event.data?.logPath || '', percent: 100 });
    } else if (event.type === 'error') {
      void updatePersistentDeployTask(task.persistentId, { error: event.message, stage: event.stage || task.currentStage });
    }
    return event;
  };

  return {
    stage(stage, percent, message, detail = '') {
      return write({ type: 'stage', stage, percent, message, detail });
    },
    log(level, message, stage = '') {
      return write({ type: 'log', level, stage, message });
    },
    result(data) {
      return write({ type: 'result', data });
    },
    error(message, stage = '') {
      return write({ type: 'error', stage, message });
    },
  };
}

/**
 * 判断任务是否已有错误事件。
 * @param {Object} task - 任务上下文
 * @returns {boolean} 是否已有错误事件
 */
function hasTaskErrorEvent(task) {
  return task.events.some((event) => event.type === 'error');
}

/**
 * 完成任务并清理订阅。
 * @param {Object} task - 任务上下文
 */
function completeDeployTask(task) {
  task.completed = true;
  deployTasksByTargetId.delete(task.targetId);
  task.subscribers.forEach((res) => {
    if (!res.writableEnded) res.end();
  });
  task.subscribers.clear();
}

/**
 * 启动部署目标任务。
 * @param {Object} task - 任务上下文
 * @param {() => Promise<Object>} runner - 任务执行器
 * @param {Object} emit - 进度输出器
 * @returns {Promise<Object>} 任务 Promise
 */
function startDeployTask(task, runner, emit) {
  const promise = Promise.resolve()
    .then(runner)
    .then(async (result) => {
      task.result = result;
      const status = result?.status === 'stopped' ? 'stopped' : 'success';
      await updatePersistentDeployTask(task.persistentId, {
        status,
        percent: 100,
        resultRef: result?.id ? String(result.id) : '',
        logPath: result?.logPath || '',
      });
      return result;
    })
    .catch(async (error) => {
      task.error = error instanceof Error ? error.message : String(error);
      if (!hasTaskErrorEvent(task)) emit.error(task.error, task.currentStage);
      const failedRecord = error?.deployRecord || null;
      await updatePersistentDeployTask(task.persistentId, {
        status: 'failed',
        error: task.error,
        stage: task.currentStage,
        resultRef: failedRecord?.id ? String(failedRecord.id) : '',
        logPath: failedRecord?.logPath || '',
      });
      throw error;
    })
    .finally(() => {
      completeDeployTask(task);
    });
  task.promise = promise;
  promise.catch(() => {});
  return promise;
}

/**
 * 服务关闭前中止当前进程内的部署任务，并短暂等待终态回写。
 * @param {string} reason - 中止原因
 * @returns {Promise<void>}
 */
export async function abortRunningDeployTasks(reason = '雨燕服务关闭，发布任务已停止') {
  const tasks = Array.from(deployTasksByTargetId.values()).filter((task) => !task.completed);
  if (!tasks.length) return;

  tasks.forEach((task) => {
    if (!task.controller.signal.aborted) {
      task.controller.abort(new DeployStoppedError(reason));
    }
  });

  const pendingPromises = tasks.map((task) => task.promise).filter(Boolean);
  if (!pendingPromises.length) return;
  await Promise.race([
    Promise.allSettled(pendingPromises),
    new Promise((resolve) => setTimeout(resolve, DEPLOY_SHUTDOWN_GRACE_MS)),
  ]);
}

/**
 * 输出任务进度。
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 * @param {Object} task - 任务上下文
 * @param {boolean} streamMode - 是否流式输出
 */
async function sendDeployTaskProgress(req, res, task, streamMode) {
  if (!streamMode) {
    res.json({ success: true, data: serializeDeployTask(task) });
    return;
  }

  prepareProgressStream(res);
  task.events.forEach((event) => writeProgressEvent(res, event));
  if (task.completed) {
    if (!res.writableEnded) res.end();
    return;
  }

  task.subscribers.add(res);
  const unsubscribe = () => {
    task.subscribers.delete(res);
    req.off?.('aborted', unsubscribe);
    res.off?.('close', unsubscribe);
  };
  req.on('aborted', unsubscribe);
  res.on('close', unsubscribe);
}

/**
 * 返回并发上限冲突。
 * @param {Object} res - Express 响应对象
 */
function sendDeployLimitConflict(res) {
  res.status(409).json({
    success: false,
    error: `当前已有 ${MAX_RUNNING_DEPLOY_TASKS} 个发布任务正在执行，请稍后重试`,
    data: {
      maxConcurrent: MAX_RUNNING_DEPLOY_TASKS,
      runningCount: deployTasksByTargetId.size,
    },
  });
}

/**
 * 返回部署目标占用冲突。
 * @param {Object} res - Express 响应对象
 * @param {Object} task - 当前执行中的任务
 */
function sendDeployTargetBusy(res, task) {
  const actionText = task?.action === 'undoRollback' ? '撤销回滚' : task?.action === 'rollback' ? '回滚' : '发布';
  const operatorText = task?.operator ? `「${task.operator}」` : '其他成员';
  const startedText = task?.startedAt ? `（开始于 ${task.startedAt}）` : '';
  res.status(409).json({
    success: false,
    error: `该部署目标正由 ${operatorText} 执行${actionText}${startedText}，请稍后重试`,
    data: serializeDeployTask(task),
  });
}

/**
 * 从请求头读取 GitLab Token。
 * @param {Object} req - Express 请求对象
 * @returns {string} GitLab Token
 */
function getGitlabTokenFromRequest(req) {
  const token = req.headers['x-gitlab-token'];
  return Array.isArray(token) ? String(token[0] || '') : String(token || '');
}

/**
 * 从请求头读取 GitLab Host。
 * @param {Object} req - Express 请求对象
 * @returns {string} GitLab Host
 */
function getGitlabHostFromRequest(req) {
  const host = req.headers['x-gitlab-host'];
  return Array.isArray(host) ? String(host[0] || '') : String(host || '');
}

/**
 * 判断是否使用流式响应
 * @param {Object} req - Express 请求对象
 * @returns {boolean} 是否流式响应
 */
function isStreamRequest(req) {
  const streamQuery = String(req.query?.stream || '').toLowerCase();
  const accept = String(req.headers.accept || '');
  return streamQuery === '1' || streamQuery === 'true' || accept.includes('application/x-ndjson');
}

/**
 * 统一错误响应
 * @param {Object} res - Express 响应对象
 * @param {unknown} error - 错误对象
 * @param {number} status - HTTP 状态码
 */
function sendError(res, error, status = 500) {
  const message = error instanceof Error ? error.message : String(error);
  if (!res.headersSent) {
    const responseStatus = Number.isInteger(error?.status) ? error.status : status;
    const payload = { success: false, error: message };
    if (typeof error?.code === 'string' && error.code) payload.code = error.code;
    if (error?.details && typeof error.details === 'object') payload.details = error.details;
    res.status(responseStatus).json(payload);
  }
}

/**
 * 校验服务器参数
 * @param {Object} body - 请求体
 */
function validateServerPayload(body) {
  if (!body?.name) throw new Error('服务器名称必填');
  if (!body?.host) throw new Error('服务器 IP/域名必填');
  if (!body?.username) throw new Error('登录账号必填');
  if (!body?.id && body?.authType === 'password' && !body?.password) throw new Error('密码认证必须填写密码');
  if (!body?.id && body?.authType === 'privateKey' && !body?.privateKey) throw new Error('SSH Key 认证必须填写私钥');
  if (String(body?.nginxTestCommand || 'nginx -t').includes('\n')) throw new Error('Nginx 校验命令不能包含换行');
  if (String(body?.nginxReloadCommand || 'nginx -s reload').includes('\n')) throw new Error('Nginx 重载命令不能包含换行');
  if (String(body?.defaultBackendRoot || '').trim() && !String(body.defaultBackendRoot).trim().startsWith('/')) {
    throw new Error('后端项目根目录必须使用服务器绝对路径');
  }
}

/**
 * 校验 Nginx 运行时初始化参数
 * @param {Object} body - 请求体
 */
function validateNginxRuntimePayload(body = {}) {
  const baseRoot = String(body.baseRoot || '/opt/yuyan').trim();
  if (!baseRoot.startsWith('/')) throw new Error('Nginx 根目录必须使用服务器绝对路径');
  if (baseRoot.includes('\n')) throw new Error('Nginx 根目录不能包含换行');
  const portStart = Number(body.portStart || 8080);
  if (!Number.isInteger(portStart) || portStart < 1 || portStart > 65535) throw new Error('端口起始值必须在 1-65535 之间');
}

/**
 * 校验 Nginx 实例参数
 * @param {Object} body - 请求体
 */
function validateNginxInstancePayload(body = {}) {
  if (!String(body.name || '').trim()) throw new Error('Nginx 实例名称必填');
  if (body.instanceType && !['external', 'managed'].includes(String(body.instanceType))) throw new Error('Nginx 实例类型不合法');
  if (body.runtimeFingerprint && !/^[a-f\d]{64}$/i.test(String(body.runtimeFingerprint).trim())) {
    throw new Error('Nginx 运行时指纹格式不合法');
  }
  const instanceType = body.instanceType === 'managed' ? 'managed' : 'external';
  if (instanceType === 'managed') {
    validateNginxRuntimePayload(body);
  }
  if (String(body.nginxTestCommand || 'nginx -t').includes('\n')) throw new Error('Nginx 校验命令不能包含换行');
  if (String(body.nginxReloadCommand || 'nginx -s reload').includes('\n')) throw new Error('Nginx 重载命令不能包含换行');
  if (String(body.defaultDeployRoot || '').trim() && !String(body.defaultDeployRoot).trim().startsWith('/')) {
    throw new Error('默认部署根目录必须使用服务器绝对路径或包含 {appName} 的绝对路径模板');
  }
  if (String(body.defaultNginxConfPath || '').trim() && !String(body.defaultNginxConfPath).trim().startsWith('/')) {
    throw new Error('默认配置文件必须使用服务器绝对路径或包含 {appName} 的绝对路径模板');
  }
}

/**
 * 校验部署目标参数
 * @param {Object} body - 请求体
 */
async function validateTargetPayload(body) {
  if (body?.projectSource && !['ops', 'gitlab'].includes(String(body.projectSource))) throw new Error('项目来源不合法');
  if (body?.projectType && !['frontend', 'backend'].includes(String(body.projectType))) throw new Error('项目类型不合法');
  if (!body?.projectId) throw new Error('项目 ID 必填');
  if (!body?.projectName) throw new Error('项目名称必填');
  if (!body?.repositoryUrl) throw new Error('仓库地址必填');
  if (!String(body?.defaultBranch || '').trim()) throw new Error('部署分支必填');
  if (!body?.serverId) throw new Error('部署服务器必填');
  const isBackend = body?.projectType === 'backend';
  if (!isBackend) {
    if (!body?.nginxInstanceId) throw new Error('Nginx 实例必填');
    if (!String(body?.nginxConfPath || '').trim()) throw new Error('Nginx 配置文件路径必填');
    if (!String(body.nginxConfPath).trim().startsWith('/')) throw new Error('Nginx 配置文件路径必须使用服务器绝对路径');
  }
  if (!String(body?.deployRoot || '').trim()) throw new Error('部署根目录必填');
  if (!String(body.deployRoot).trim().startsWith('/')) throw new Error('部署根目录必须使用服务器绝对路径');
  if (String(body.defaultBranch || '').includes('\n')) throw new Error('部署分支不能包含换行');
  if (String(body.artifactDir || '').includes('\n')) throw new Error('产物目录不能包含换行');
  if (String(body.preserveSubDirs || '').includes('\n')) throw new Error('保留子目录请使用逗号分隔，不能包含换行');
  if (body.uploadStrategy && !['cleanReplace', 'overlayKeepAssets'].includes(String(body.uploadStrategy))) throw new Error('资源上传策略不合法');
  if (!isBackend && body.nginxSiteManaged) {
    const listenPort = Number(body.listenPort || 0);
    if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) throw new Error('托管站点监听端口必须在 1-65535 之间');
    if (String(body.serverName || '').includes('\n')) throw new Error('server_name 不能包含换行');
  }
  if (isBackend) {
    const serverPort = Number(body.serverPort || 0);
    if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) throw new Error('后端服务端口必须在 1-65535 之间');
    if (!Number(body.buildJdkId || body.jdkId || 0)) {
      if (body.requiredJdkAlias) {
        const matchedLocal = await findJdkByAlias(body.requiredJdkAlias);
        if (matchedLocal?.id) {
          body.buildJdkId = matchedLocal.id;
          body.jdkId = matchedLocal.id;
        }
      }
    }
    if (!Number(body.buildJdkId || body.jdkId || 0)) throw new Error('本机构建 JDK 必填，请先在 Java 环境管理中扫描或配置本机构建 JDK');
    if (!String(body.runtimeJavaHome || '').trim().startsWith('/')) throw new Error('服务器运行 JAVA_HOME 必须使用绝对路径');
    if (!normalizeCommandText(body.buildCommand)) throw new Error('Maven 构建命令必填');
    if (!String(body.artifactPattern || body.artifactDir || '').trim()) throw new Error('Jar 产物路径必填');
    if (body.processMode === 'legacy') throw new Error('历史自定义启停命令已停用，请选择 PID 或 systemd 模式');
    if (body.processMode && !['pid', 'systemd'].includes(String(body.processMode))) throw new Error('进程管理模式不合法');
    if (body.serviceRole && !['application', 'gateway'].includes(String(body.serviceRole))) throw new Error('后端服务角色不合法');
  }
}

/**
 * 清洗多行命令文本
 * @param {string} commandText - 命令文本
 * @returns {string} 去空行后的命令文本
 */
function normalizeCommandText(commandText) {
  return String(commandText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * 获取服务器列表
 */
export async function handleListServers(_req, res) {
  try {
    res.json({ success: true, data: await listServers() });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * 保存服务器展示顺序。
 */
export async function handleReorderServers(req, res) {
  try {
    res.json({ success: true, data: await reorderServers(req.body?.serverIds) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 创建服务器
 */
export async function handleCreateServer(req, res) {
  try {
    validateServerPayload(req.body);
    res.json({ success: true, data: await createServer(req.body) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 更新服务器
 */
export async function handleUpdateServer(req, res) {
  try {
    validateServerPayload({ ...req.body, id: req.params.id });
    const server = await updateServer(Number(req.params.id), req.body);
    if (!server) return sendError(res, new Error('服务器不存在'), 404);
    res.json({ success: true, data: server });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 删除服务器
 */
export async function handleDeleteServer(req, res) {
  try {
    const result = await deleteServer(Number(req.params.id), { requireEmpty: String(req.query?.requireEmpty || '') === '1' });
    res.json({ success: true, data: result });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * 测试服务器连接
 */
export async function handleTestServer(req, res) {
  try {
    if (!(await getServerWithCredential(Number(req.params.id)))) {
      return sendError(res, new Error('服务器不存在'), 404);
    }
    res.json({ success: true, data: await testServer(Number(req.params.id)) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 获取服务器 Nginx 实例列表
 */
export async function handleListNginxInstances(req, res) {
  try {
    res.json({ success: true, data: await listNginxInstances(Number(req.params.id)) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 获取服务器前端部署根目录候选。
 */
export async function handleListDeployRootOptions(req, res) {
  try {
    res.json({
      success: true,
      data: await listDeployRootOptions(Number(req.params.id), {
        nginxInstanceId: Number(req.query?.nginxInstanceId || 0),
        excludeTargetId: Number(req.query?.excludeTargetId || 0),
      }),
    });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 只读发现服务器宿主机 Nginx 与前端站点。
 */
export async function handleDiscoverServerNginx(req, res) {
  const abortController = new AbortController();
  /** 客户端断开后终止仍在运行的只读 SSH 扫描。 */
  const abortScan = () => abortController.abort(new Error('客户端已取消 Nginx 扫描'));
  /** 仅在响应未正常完成时处理中断。 */
  const handleResponseClose = () => {
    if (!res.writableEnded) abortScan();
  };
  req.on('aborted', abortScan);
  res.on('close', handleResponseClose);
  try {
    res.json({
      success: true,
      data: await discoverServerNginx(Number(req.params.id), {
        useSudo: req.query?.useSudo === undefined ? undefined : String(req.query.useSudo) === '1',
        signal: abortController.signal,
      }),
    });
  } catch (error) {
    if (abortController.signal.aborted && !res.headersSent) return;
    sendError(res, error, 400);
  } finally {
    req.off('aborted', abortScan);
    res.off('close', handleResponseClose);
  }
}

/**
 * 创建服务器 Nginx 实例
 */
export async function handleCreateNginxInstance(req, res) {
  try {
    validateNginxInstancePayload(req.body || {});
    res.json({ success: true, data: await createNginxInstance(Number(req.params.id), req.body || {}) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 更新 Nginx 实例
 */
export async function handleUpdateNginxInstance(req, res) {
  try {
    validateNginxInstancePayload(req.body || {});
    const instance = await updateNginxInstance(Number(req.params.id), req.body || {});
    if (!instance) return sendError(res, new Error('Nginx 实例不存在'), 404);
    res.json({ success: true, data: instance });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 删除 Nginx 实例
 */
export async function handleDeleteNginxInstance(req, res) {
  try {
    res.json({ success: true, data: await deleteNginxInstance(Number(req.params.id)) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 获取 Nginx 实例状态
 */
export async function handleGetNginxInstanceStatus(req, res) {
  try {
    res.json({ success: true, data: await getNginxInstanceStatus(Number(req.params.id)) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

export async function handleDownloadNginxInstanceArchive(req, res) {
  try {
    const type = req.query.type || 'all';
    const siteIds = String(req.query.siteIds || '').split(',').map((value) => value.trim()).filter(Boolean);
    const revision = String(req.query.revision || '').trim();
    await streamNginxInstanceArchive(Number(req.params.id), type, res, ({ fileName, baseRoot, scriptPath }) => {
      res.status(200);
      const contentType = type === 'conf' ? 'text/plain; charset=utf-8' : 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      res.setHeader('Content-Encoding', 'identity');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('X-Nginx-Base-Root', encodeURIComponent(baseRoot || ''));
      res.setHeader('X-Nginx-Script-Path', encodeURIComponent(scriptPath || ''));
      res.flushHeaders?.();
    }, { siteIds, revision });
    if (!res.writableEnded) res.end();
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    sendError(res, error, Number(error?.status || 400));
  }
}

/**
 * 获取托管 Nginx 主配置中的可下载 server 列表。
 */
export async function handleListNginxInstanceArchiveSites(req, res) {
  try {
    res.json({ success: true, data: await getNginxInstanceArchiveSites(Number(req.params.id)) });
  } catch (error) {
    sendError(res, error, Number(error?.status || 400));
  }
}

/**
 * 另存为直写：导出托管 Nginx 实例运行包并保存到指定绝对物理路径，实时输出 SSE 进度。
 */
export async function handleSaveNginxInstanceArchive(req, res) {
  const { filePath, type } = req.body;
  if (!filePath) {
    return sendError(res, new Error('缺少保存文件路径'), 400);
  }
  
  let isAborted = false;
  try {
    // 设置响应为分块事件流 (SSE)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    req.on('aborted', () => {
      isAborted = true;
    });
    res.on('close', () => {
      if (!res.writableEnded) isAborted = true;
    });

    /**
     * 写入运行包保存事件。
     * @param {Object} event - SSE 事件数据
     */
    const writeArchiveEvent = (event) => {
      if (!isAborted) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (typeof res.flush === 'function') {
          res.flush();
        }
      }
    };

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    writeArchiveEvent({ stage: 'preparing', message: '正在创建本地保存目录' });

    const meta = await saveNginxInstanceArchiveToPath(Number(req.params.id), type || 'all', filePath, writeArchiveEvent, () => isAborted);
    
    if (!isAborted) {
      writeArchiveEvent({
        stage: 'finished',
        message: '运行包已保存到本地磁盘',
        finished: true,
        filePath,
        fileName: meta?.fileName || path.basename(filePath),
      });
      res.end();
    }
  } catch (error) {
    if (isAborted) {
      if (!res.writableEnded) res.end();
      return;
    }
    if (!res.headersSent) {
      sendError(res, error, 400);
    } else {
      endArchiveSseWithError(res, error);
    }
  }
}

/**
 * 初始化 Nginx 实例
 */
export async function handleInitNginxInstance(req, res) {
  const instanceId = Number(req.params.id);
  const streamMode = isStreamRequest(req);
  const write = (payload) => {
    const event = { timestamp: new Date().toISOString(), ...payload };
    if (streamMode) writeProgressEvent(res, event);
    return event;
  };
  const emit = {
    stage: (stage, percent, message, detail = '') => write({ type: 'stage', stage, percent, message, detail }),
    log: (level, message, stage = '') => write({ type: 'log', level, stage, message }),
    result: (data) => write({ type: 'result', data }),
    error: (message, stage = '') => write({ type: 'error', stage, message }),
  };

  try {
    validateNginxRuntimePayload(req.body || {});
    if (!streamMode) {
      res.json({ success: true, data: await initializeNginxInstanceRuntime(instanceId, req.body || {}, emit) });
      return;
    }
    prepareProgressStream(res);
    const result = await initializeNginxInstanceRuntime(instanceId, req.body || {}, emit);
    emit.result(result);
    if (!res.writableEnded) res.end();
  } catch (error) {
    if (streamMode) {
      emit.error(error instanceof Error ? error.message : String(error));
      if (!res.writableEnded) res.end();
      return;
    }
    sendError(res, error, 400);
  }
}

/**
 * 执行 Nginx 实例操作
 */
export async function handleRunNginxInstanceAction(req, res) {
  try {
    res.json({ success: true, data: await runNginxInstanceAction(Number(req.params.id), String(req.params.action || '')) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 获取 Nginx 实例下一个可用端口
 */
export async function handleGetNextNginxInstancePort(req, res) {
  try {
    res.json({
      success: true,
      data: await getNextNginxInstancePort(Number(req.params.id), Number(req.query?.excludeTargetId || 0)),
    });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 获取服务器托管 Nginx 运行时状态
 */
export async function handleGetNginxRuntime(req, res) {
  try {
    res.json({ success: true, data: await getNginxRuntimeStatus(Number(req.params.id)) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 初始化服务器托管 Nginx 运行时
 */
export async function handleInitNginxRuntime(req, res) {
  const serverId = Number(req.params.id);
  const streamMode = isStreamRequest(req);
  const write = (payload) => {
    const event = { timestamp: new Date().toISOString(), ...payload };
    if (streamMode) writeProgressEvent(res, event);
    return event;
  };
  const emit = {
    stage: (stage, percent, message, detail = '') => write({ type: 'stage', stage, percent, message, detail }),
    log: (level, message, stage = '') => write({ type: 'log', level, stage, message }),
    result: (data) => write({ type: 'result', data }),
    error: (message, stage = '') => write({ type: 'error', stage, message }),
  };

  try {
    validateNginxRuntimePayload(req.body || {});
    if (!streamMode) {
      res.json({ success: true, data: await initializeNginxRuntime(serverId, req.body || {}, emit) });
      return;
    }
    prepareProgressStream(res);
    const result = await initializeNginxRuntime(serverId, req.body || {}, emit);
    emit.result(result);
    if (!res.writableEnded) res.end();
  } catch (error) {
    if (streamMode) {
      emit.error(error instanceof Error ? error.message : String(error));
      if (!res.writableEnded) res.end();
      return;
    }
    sendError(res, error, 400);
  }
}

/**
 * 执行托管 Nginx 运行时操作
 */
export async function handleRunNginxRuntimeAction(req, res) {
  try {
    res.json({ success: true, data: await runNginxRuntimeAction(Number(req.params.id), String(req.params.action || '')) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 获取托管 Nginx 下一个可用端口
 */
export async function handleGetNextNginxRuntimePort(req, res) {
  try {
    res.json({
      success: true,
      data: await getNextNginxRuntimePort(Number(req.params.id), Number(req.query?.excludeTargetId || 0)),
    });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 获取部署目标列表
 */
export async function handleListTargets(req, res) {
  try {
    res.json({ success: true, data: await listTargets(req.query || {}) });
  } catch (error) {
    sendError(res, error);
  }
}

/** 聚合当前团队全部运行中的部署目标快照。 */
export async function handleListTargetRuntimeSnapshots(_req, res) {
  try {
    const targetIndex = await listTargetRuntimeIndex();
    const inMemorySnapshots = [];
    deployTasksByTargetId.forEach((task, targetId) => {
      if (!task.completed) inMemorySnapshots.push(serializeDeployTaskRuntime({ ...task, targetId: Number(targetId) }));
    });

    const centralOperations = await listActiveCentralDeployOperations();
    const items = mergeDeployRuntimeSnapshots({
      targetIds: targetIndex.map((target) => target.id),
      inMemorySnapshots,
      centralOperations,
    });
    res.json({
      success: true,
      data: {
        items,
        checkedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * 创建部署目标
 */
export async function handleCreateTarget(req, res) {
  try {
    await validateTargetPayload(req.body);
    const isBackend = req.body.projectType === 'backend';
    res.json({
      success: true,
      data: await createTarget({
        ...req.body,
        projectSource: req.body.projectSource === 'gitlab' ? 'gitlab' : 'ops',
        envName: req.body.envName || '测试',
        installCommand: normalizeCommandText(req.body.installCommand) || (isBackend ? '' : 'pnpm install'),
        buildCommand: normalizeCommandText(req.body.buildCommand) || (isBackend ? '' : 'pnpm build'),
        artifactDir: req.body.artifactDir || '',
        preserveSubDirs: req.body.preserveSubDirs || '',
        nginxSiteManaged: Boolean(req.body.nginxSiteManaged),
        listenPort: req.body.listenPort ? Number(req.body.listenPort) : 0,
        serverName: req.body.serverName || '_',
        enableNginxTest: Boolean(req.body.enableNginxTest),
        enableNginxReload: Boolean(req.body.enableNginxReload),
      }),
    });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 更新部署目标
 */
export async function handleUpdateTarget(req, res) {
  try {
    await validateTargetPayload(req.body);
    const isBackend = req.body.projectType === 'backend';
    const target = await updateTarget(Number(req.params.id), {
      ...req.body,
      projectSource: req.body.projectSource === 'gitlab' ? 'gitlab' : 'ops',
      envName: req.body.envName || '测试',
      installCommand: normalizeCommandText(req.body.installCommand) || (isBackend ? '' : 'pnpm install'),
      buildCommand: normalizeCommandText(req.body.buildCommand) || (isBackend ? '' : 'pnpm build'),
      artifactDir: req.body.artifactDir || '',
      preserveSubDirs: req.body.preserveSubDirs || '',
      nginxSiteManaged: Boolean(req.body.nginxSiteManaged),
      listenPort: req.body.listenPort ? Number(req.body.listenPort) : 0,
      serverName: req.body.serverName || '_',
      enableNginxTest: Boolean(req.body.enableNginxTest),
      enableNginxReload: Boolean(req.body.enableNginxReload),
    });
    if (!target) return sendError(res, new Error('部署目标不存在'), 404);
    res.json({ success: true, data: target });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 删除部署目标
 */
export async function handleDeleteTarget(req, res) {
  try {
    const result = await deleteTarget(Number(req.params.id), { rejectRunning: String(req.query?.safe || '') === '1' });
    res.json({ success: true, data: result });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * 获取发布记录列表
 */
export async function handleListRecords(req, res) {
  try {
    res.json({ success: true, data: await listRecords({ ...(req.query || {}), gitlabToken: getGitlabTokenFromRequest(req), gitlabHost: getGitlabHostFromRequest(req) }) });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * 获取发布记录详情
 */
export async function handleGetRecord(req, res) {
  try {
    const record = await getRecord(Number(req.params.id), { gitlabToken: getGitlabTokenFromRequest(req), gitlabHost: getGitlabHostFromRequest(req) });
    if (!record) return sendError(res, new Error('发布记录不存在'), 404);
    res.json({ success: true, data: record });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * 读取 Nginx 配置文件
 */
export async function handleReadNginxConfig(req, res) {
  try {
    res.json({ success: true, data: await readNginxConfig(Number(req.params.id)) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 保存 Nginx 配置文件
 */
export async function handleSaveNginxConfig(req, res) {
  try {
    res.json({ success: true, data: await saveNginxConfig(Number(req.params.id), req.body || {}) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 执行 Nginx 配置文件校验
 */
export async function handleTestNginx(req, res) {
  try {
    res.json({ success: true, data: await testTargetNginx(Number(req.params.id)) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 同步部署目标托管 Nginx 站点配置
 */
export async function handleSyncTargetNginxSite(req, res) {
  try {
    res.json({ success: true, data: await syncTargetNginxSite(Number(req.params.id)) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 执行部署
 */
export async function handleDeployTarget(req, res) {
  const targetId = Number(req.params.id);
  if (!targetId) {
    sendError(res, new Error('部署目标 ID 无效'), 400);
    return;
  }
  const runningTask = deployTasksByTargetId.get(targetId);
  const streamMode = isStreamRequest(req);
  if (runningTask) {
    if (runningTask.action !== 'deploy') {
      sendDeployTargetBusy(res, runningTask);
      return;
    }
    await sendDeployTaskProgress(req, res, runningTask, streamMode);
    return;
  }
  if (deployTasksByTargetId.size >= MAX_RUNNING_DEPLOY_TASKS) {
    sendDeployLimitConflict(res);
    return;
  }

  const task = await createDeployTask(targetId, 'deploy', req.body || {});
  const emit = createProgressEmitter(task);
  deployTasksByTargetId.set(targetId, task);
  startDeployTask(task, () => deployTarget(targetId, { ...(req.body || {}), signal: task.controller.signal }, emit), emit);
  if (!streamMode) {
    try {
      res.json({ success: true, data: await task.promise });
    } catch (error) {
      sendError(res, error, 400);
    }
    return;
  }
  await sendDeployTaskProgress(req, res, task, streamMode);
}

/**
 * 读取部署目标运行中的发布进度
 */
export async function handleGetTargetDeployProgress(req, res) {
  const targetId = Number(req.params.id);
  const task = deployTasksByTargetId.get(targetId);
  if (!task) {
    sendError(res, new Error('该部署目标当前没有运行中的发布任务'), 404);
    return;
  }
  await sendDeployTaskProgress(req, res, task, isStreamRequest(req));
}

/**
 * 停止部署目标运行中的发布任务
 */
export async function handleStopDeployTarget(req, res) {
  const targetId = Number(req.params.id);
  const task = deployTasksByTargetId.get(targetId);
  if (!task) {
    sendError(res, new Error('该部署目标当前没有运行中的发布任务'), 404);
    return;
  }
  if (!['deploy', 'openapi'].includes(task.action)) {
    sendError(res, new Error('当前任务不支持停止'), 400);
    return;
  }
  if (!STOPPABLE_DEPLOY_STAGE_KEYS.has(task.currentStage)) {
    sendError(res, new Error('上传产物后不可停止当前发布任务'), 400);
    return;
  }
  const operator = String(req.body?.operator || '').trim();
  const role = String(req.body?.role || '').trim();
  const isOwner = Boolean(operator && task.operator && (operator === task.operator || task.operator === '未知操作人'));
  const isAdmin = role === 'admin';
  if (task.operator && task.operator !== '未知操作人' && !isOwner && !isAdmin) {
    sendError(res, new Error(`无权停止该任务：当前任务由「${task.operator}」发起，仅本人或管理员(admin)可执行强制停止`), 403);
    return;
  }
  const stopReason = !isOwner && isAdmin
    ? `管理员「${operator || 'admin'}」已强制停止该发布任务`
    : '用户已停止发布任务';
  task.controller.abort(new DeployStoppedError(stopReason));
  res.json({ success: true, data: serializeDeployTask(task) });
}

/**
 * 执行发布记录恢复类任务。
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 * @param {'rollback'|'undoRollback'} action - 恢复操作类型
 * @param {(recordId: number, body: Object, emit: Object) => Promise<Object>} runner - 任务执行器
 */
async function handleRestoreRecordTask(req, res, action, runner) {
  const recordId = Number(req.params.id);
  if (!recordId) {
    sendError(res, new Error('发布记录 ID 无效'), 400);
    return;
  }
  let sourceRecord = null;
  try {
    sourceRecord = await getRecord(recordId);
    if (!sourceRecord) throw new Error('发布记录不存在');
    if (action === 'rollback' && !sourceRecord.canRollback) throw new Error('该记录当前不可回滚');
    if (action === 'undoRollback' && !sourceRecord.canUndoRollback) throw new Error('该记录当前不可撤销回滚');
  } catch (error) {
    sendError(res, error, 400);
    return;
  }

  const runningTask = deployTasksByTargetId.get(sourceRecord.targetId);
  if (runningTask) {
    sendDeployTargetBusy(res, runningTask);
    return;
  }
  if (deployTasksByTargetId.size >= MAX_RUNNING_DEPLOY_TASKS) {
    sendDeployLimitConflict(res);
    return;
  }

  const streamMode = isStreamRequest(req);
  const task = await createDeployTask(sourceRecord.targetId, action, req.body || {});
  const emit = createProgressEmitter(task);
  deployTasksByTargetId.set(sourceRecord.targetId, task);
  startDeployTask(task, () => runner(recordId, req.body || {}, emit), emit);
  if (!streamMode) {
    try {
      res.json({ success: true, data: await task.promise });
    } catch (error) {
      sendError(res, error, 400);
    }
    return;
  }
  await sendDeployTaskProgress(req, res, task, streamMode);
}

/**
 * 回滚发布记录
 */
export async function handleRollbackRecord(req, res) {
  await handleRestoreRecordTask(req, res, 'rollback', rollbackRecord);
}

/**
 * 撤销回滚发布记录
 */
export async function handleUndoRollbackRecord(req, res) {
  await handleRestoreRecordTask(req, res, 'undoRollback', undoRollbackRecord);
}

/**
 * 备份/下载数据库 SQLite 文件
 */
export async function handleBackupDb(_req, res) {
  try {
    res.download(DEPLOY_DB_PATH, 'deploy.sqlite');
  } catch (error) {
    sendError(res, error, 500);
  }
}

/**
 * 恢复/覆盖本地数据库 SQLite 文件
 */
export async function handleRestoreDb(req, res) {
  try {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return sendError(res, new Error('无效的数据库文件内容'), 400);
    }
    
    console.log(`[restore] 准备覆盖本地数据库，文件大小: ${req.body.length} 字节`);
    
    // 1. 关闭现有数据库连接释放文件锁
    closeDeployDb();
    
    // 2. 覆盖写入本地的 SQLite 数据库文件
    await fs.writeFile(DEPLOY_DB_PATH, req.body);
    console.log('[restore] 本地数据库文件已覆盖写入完成');
    
    // 3. 重新打开并初始化数据库连接
    await getDeployDb();
    console.log('[restore] 数据库连接已重新初始化成功');
    
    res.json({ success: true, message: '数据库恢复同步成功' });
  } catch (error) {
    console.error('[restore] 还原数据库时出错:', error);
    sendError(res, error, 500);
  }
}

/** 兼容旧客户端实时代理请求的中断控制器。 */
const activeUpdateAbortControllers = new Set();

/**
 * 注册更新下载 AbortController。
 * @param {AbortController} controller - 取消控制器
 * @returns {() => void} 取消注册函数
 */
function trackUpdateAbortController(controller) {
  activeUpdateAbortControllers.add(controller);
  return () => activeUpdateAbortControllers.delete(controller);
}

/**
 * 中断所有正在进行的更新下载、预下载和代理缓存写入。
 * @param {string} reason - 中断原因
 */
export function abortAppUpdateTransfers(reason = 'shutdown') {
  for (const controller of activeUpdateAbortControllers) {
    controller.abort(reason);
  }
  activeUpdateAbortControllers.clear();
  updateAssetCacheManager.abortAll();
}

/**
 * 构建 GitHub Release Asset 的下载与缓存状态地址。
 * @param {object} asset - 缓存资源元数据
 * @param {boolean} cacheAware - 客户端是否理解缓存准备状态
 * @returns {{ downloadUrl: string, cacheStatusUrl: string }} 相对接口地址
 */
function buildGithubUpdateAssetUrls(asset, cacheAware) {
  const query = new URLSearchParams({
    assetId: String(asset.assetId),
    filename: String(asset.filename),
  });
  if (cacheAware) query.set('cacheAware', '1');
  return {
    downloadUrl: `/deploy-api/app-update/download-asset?${query.toString()}`,
    cacheStatusUrl: `/deploy-api/app-update/cache-status?assetId=${encodeURIComponent(asset.assetId)}&filename=${encodeURIComponent(asset.filename)}`,
  };
}

/**
 * 将更新资源相对路径转换为当前内网 API 的绝对地址。
 * @param {object} req Express 请求
 * @param {string} resourcePath 资源相对路径
 * @returns {string} 绝对下载地址
 */
function buildAbsoluteAppUpdateUrl(req, resourcePath) {
  const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim();
  const protocol = forwardedProtocol || req.protocol || 'http';
  const host = req.get('host');
  if (!host) throw new Error('Updater 请求缺少 Host');
  return new URL(resourcePath, `${protocol}://${host}`).toString();
}

/**
 * 构建返回客户端的缓存状态。
 * @param {object} status - 缓存服务状态
 * @param {string} cacheStatusUrl - 状态查询地址
 * @returns {object} 客户端缓存状态
 */
function buildClientCacheStatus(status, cacheStatusUrl) {
  return {
    status: status.status,
    progress: status.progress,
    downloadedBytes: status.downloadedBytes,
    totalBytes: status.totalBytes,
    bytesPerSecond: status.bytesPerSecond,
    remainingSeconds: status.remainingSeconds,
    retryCount: status.retryCount,
    error: status.error,
    etag: status.etag,
    statusUrl: cacheStatusUrl,
  };
}

/**
 * 自动更新版本检测（统一通过服务端环境变量 GITHUB_TOKEN 代理访问 GitHub API）
 */
export async function handleCheckAppUpdate(req, res) {
  const {
    currentVersion,
    platform,
    arch = 'x86_64',
    channel = 'stable',
    cacheAware = '0',
    updaterCapable = '0',
  } = req.query;
  if (!currentVersion) {
    return sendError(res, new Error('缺少必要参数 currentVersion'), 400);
  }

  try {
    const normalizedPlatform = normalizeUpdatePlatform(platform);
    const normalizedArch = normalizeUpdateArch(arch);
    const normalizedChannel = normalizeUpdateChannel(channel);
    const target = `${normalizedPlatform}-${normalizedArch}`;
    if (!normalizedPlatform || !normalizedArch) {
      return sendError(res, new Error('不支持的客户端平台或架构'), 400);
    }

    const manifest = await readPublishedUpdateManifest(normalizedChannel);
    const manifestPlatformAsset = getManifestAsset(manifest, normalizedPlatform, normalizedArch);
    const wantsUpdater = String(updaterCapable) === '1';
    const manifestAsset = wantsUpdater
      ? manifestPlatformAsset?.updater
      : manifestPlatformAsset;
    if (wantsUpdater && manifestAsset && !manifestAsset.signature) {
      return sendError(res, new Error('更新清单中的 Updater 资源缺少签名'), 503);
    }
    if (manifest && isNewerAppVersion(currentVersion, manifest.version) && manifestAsset) {
      const validAsset = await validateManifestAsset(
        normalizedChannel,
        manifest.version,
        target,
        manifestAsset
      );
      if (!validAsset) {
        return sendError(res, new Error('更新清单已发布，但对应安装包校验失败'), 503);
      }

      return res.json({
        hasUpdate: true,
        version: String(manifest.version).replace(/^v/, ''),
        latestVersion: String(manifest.version).replace(/^v/, ''),
        notes: manifest.notes || '无更新说明。',
        updateLogs: manifest.notes || '无更新说明。',
        url: buildPublishedAssetUrl(
          normalizedChannel,
          manifest.version,
          target,
          manifestAsset.filename
        ),
        downloadUrl: buildPublishedAssetUrl(
          normalizedChannel,
          manifest.version,
          target,
          manifestAsset.filename
        ),
        filename: manifestAsset.filename,
        size: Number(manifestAsset.size),
        sha256: manifestAsset.sha256,
        signature: manifestAsset.signature || '',
        etag: manifestAsset.etag || `"sha256-${manifestAsset.sha256}"`,
        channel: normalizedChannel,
        target,
        source: 'manifest',
        cache: {
          status: 'ready',
          progress: 100,
          downloadedBytes: Number(manifestAsset.size),
          totalBytes: Number(manifestAsset.size),
          bytesPerSecond: 0,
          remainingSeconds: 0,
          retryCount: 0,
          error: null,
          etag: manifestAsset.etag || `"sha256-${manifestAsset.sha256}"`,
          statusUrl: '',
        },
      });
    }

    if (manifest && !isNewerAppVersion(currentVersion, manifest.version)) {
      return res.json({ hasUpdate: false, message: '已是最新版本' });
    }

    const data = await fetchGithubAppReleases();

    if (!Array.isArray(data) || data.length === 0) {
      return res.json({ hasUpdate: false, message: '暂无版本发布信息' });
    }

    const compatibleRelease = selectLatestCompatibleRelease(
      data,
      normalizedPlatform,
      normalizedArch
    );
    if (!compatibleRelease) {
      return res.json({
        hasUpdate: false,
        message: '暂无包含当前系统安装包的有效版本',
      });
    }

    const { release: latestRelease, asset: installerAsset } = compatibleRelease;
    const remoteVersion = latestRelease.tag_name;

    if (isNewerAppVersion(currentVersion, remoteVersion)) {
      let targetAsset = installerAsset;
      let updaterSignature = '';
      if (wantsUpdater) {
        const updater = await fetchGithubReleaseUpdater(
          latestRelease,
          normalizedPlatform,
          normalizedArch
        );
        if (!updater?.asset?.id || !updater.signature) {
          return sendError(
            res,
            new Error('新版本尚未发布签名 Updater 资源，已阻止退回手工安装包'),
            503
          );
        }
        targetAsset = updater.asset;
        updaterSignature = updater.signature;
      }
      const cacheAsset = mapGithubAssetToCacheAsset(targetAsset);
      const urls = buildGithubUpdateAssetUrls(cacheAsset, String(cacheAware) === '1');
      const cacheStatus = await updateAssetCacheManager.ensureCached(cacheAsset);

      res.json({
        hasUpdate: true,
        version: remoteVersion.replace(/^v/, ''),
        latestVersion: remoteVersion.replace(/^v/, ''),
        notes: latestRelease.body || '无更新说明。',
        updateLogs: latestRelease.body || '无更新说明。',
        url: urls.downloadUrl,
        downloadUrl: urls.downloadUrl,
        filename: cacheAsset.filename,
        assetId: cacheAsset.assetId,
        size: Number(targetAsset.size || 0),
        sha256: String(targetAsset.digest || '').replace(/^sha256:/, ''),
        signature: updaterSignature,
        etag: '',
        channel: normalizedChannel,
        target,
        source: 'github-release',
        cache: buildClientCacheStatus(cacheStatus, urls.cacheStatusUrl),
      });
    } else {
      res.json({ hasUpdate: false, message: '已是最新版本' });
    }
  } catch (error) {
    console.error('[Update Proxy] 检查更新代理接口异常:', error);
    let status = 500;
    let errMsg = error.message;
    if (error.response) {
      status = error.response.status;
      const token = process.env.GITHUB_TOKEN || '';
      let tokenStatus = '未配置（检测到空值）';
      if (token.trim() !== '') {
        const masked = token.length > 8 
          ? `${token.slice(0, 4)}...${token.slice(-4)}` 
          : '长度过短';
        tokenStatus = `已配置 (长度: ${token.length}, 脱敏值: ${masked})`;
      }
      errMsg = `GitHub 响应错误: ${error.response.statusText || status} (${status})`;
      if (status === 401) errMsg = `鉴权失败(401)，您输入的 GitHub Token 无效或已过期。当前容器内 Token 状态: ${tokenStatus}`;
      if (status === 404) errMsg = `未找到仓库或无权限访问(404)，私有项目请检查您的 GitHub Token 设定。当前容器内 Token 状态: ${tokenStatus}`;
    } else if (error.request) {
      errMsg = '连接 GitHub 失败，网络超时，请检查您的代理或网络连接';
    }
    sendError(res, new Error(errMsg), status);
  }
}

/** 返回 Tauri 2 官方 Updater 所需的动态更新清单。 */
export async function handleCheckTauriAppUpdate(req, res) {
  const { target, arch, currentVersion } = req.params;
  const channel = normalizeUpdateChannel(req.query.channel);
  const platform = normalizeUpdatePlatform(target);
  const normalizedArch = normalizeUpdateArch(arch);
  if (!platform || !normalizedArch) {
    return sendError(res, new Error('不支持的客户端平台或架构'), 400);
  }
  const manifest = await readPublishedUpdateManifest(channel);
  const normalizedTarget = `${platform}-${normalizedArch}`;
  const manifestAsset = getManifestAsset(manifest, platform, normalizedArch)?.updater;
  if (manifestAsset && !manifestAsset.signature) {
    return sendError(res, new Error('更新清单中的 Updater 资源缺少签名'), 503);
  }
  if (manifest && isNewerAppVersion(currentVersion, manifest.version) && manifestAsset) {
    const validAsset = await validateManifestAsset(
      channel,
      manifest.version,
      normalizedTarget,
      manifestAsset
    );
    if (!validAsset) {
      return sendError(res, new Error('签名 Updater 资源校验失败'), 503);
    }
    return res.json({
      version: String(manifest.version).replace(/^v/, ''),
      pub_date: manifest.pubDate,
      notes: manifest.notes || '无更新说明。',
      url: buildAbsoluteAppUpdateUrl(
        req,
        buildPublishedAssetUrl(
          channel,
          manifest.version,
          normalizedTarget,
          manifestAsset.filename
        )
      ),
      signature: manifestAsset.signature,
    });
  }
  if (manifest && !isNewerAppVersion(currentVersion, manifest.version)) {
    return res.status(204).end();
  }

  try {
    const releases = await fetchGithubAppReleases();
    const compatible = selectLatestCompatibleRelease(releases, platform, normalizedArch);
    if (!compatible || !isNewerAppVersion(currentVersion, compatible.release.tag_name)) {
      return res.status(204).end();
    }
    const updater = await fetchGithubReleaseUpdater(
      compatible.release,
      platform,
      normalizedArch
    );
    if (!updater?.asset?.id || !updater.signature) {
      return sendError(res, new Error('当前版本尚未发布已签名的 Tauri Updater 资源'), 503);
    }
    const cacheAsset = mapGithubAssetToCacheAsset(updater.asset);
    const urls = buildGithubUpdateAssetUrls(cacheAsset, true);
    await updateAssetCacheManager.ensureCached(cacheAsset);
    return res.json({
      version: String(compatible.release.tag_name).replace(/^v/, ''),
      pub_date: compatible.release.published_at || compatible.release.created_at,
      notes: compatible.release.body || '无更新说明。',
      url: buildAbsoluteAppUpdateUrl(req, urls.downloadUrl),
      signature: updater.signature,
    });
  } catch (error) {
    console.error('[Update Proxy] Tauri updater 清单查询失败:', error);
    return sendError(res, error, 503);
  }
}

/**
 * 返回指定 GitHub Asset 的缓存准备状态。
 * @param {Object} req - Express 请求
 * @param {Object} res - Express 响应
 */
export async function handleGetAppUpdateCacheStatus(req, res) {
  try {
    const asset = updateAssetCacheManager.resolveAsset({
      assetId: req.query.assetId,
      filename: req.query.filename,
    });
    const status = await updateAssetCacheManager.ensureCached(asset);
    const urls = buildGithubUpdateAssetUrls(asset, true);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ...buildClientCacheStatus(status, urls.cacheStatusUrl),
      downloadUrl: urls.downloadUrl,
    });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 从内网缓存发送安装包并启用 Range。
 * @param {Object} res - Express 响应
 * @param {object} asset - 更新资源
 * @param {object} status - 缓存状态
 */
function sendCachedAppUpdateAsset(res, asset, status) {
  const { cachePath } = updateAssetCacheManager.getPaths(asset);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Content-Disposition', `attachment; filename=${encodeURIComponent(asset.filename)}`);
  res.setHeader('X-Update-Source', 'cache');
  if (asset.sha256) res.setHeader('ETag', `"sha256-${asset.sha256}"`);
  else if (status.etag) res.setHeader('ETag', status.etag);
  return res.sendFile(cachePath, {
    acceptRanges: true,
    cacheControl: true,
    immutable: true,
    lastModified: true,
    maxAge: '1y',
  });
}

/**
 * 代理下载 GitHub Release Asset；新客户端等待缓存，旧客户端保留实时代理兼容路径。
 * @param {Object} req - Express 请求
 * @param {Object} res - Express 响应
 */
export async function handleDownloadAppUpdateAsset(req, res) {
  let asset;
  try {
    asset = updateAssetCacheManager.resolveAsset({
      assetId: req.query.assetId,
      filename: req.query.filename,
    });
  } catch (error) {
    return sendError(res, error, 400);
  }

  const cacheAware = String(req.query.cacheAware || '') === '1';
  try {
    let cacheStatus = await updateAssetCacheManager.ensureCached(asset);
    if (cacheStatus.status === 'ready') {
      return sendCachedAppUpdateAsset(res, asset, cacheStatus);
    }

    if (!cacheAware && cacheStatus.status === 'preparing') {
      cacheStatus = await updateAssetCacheManager.waitForAsset(asset, 15_000);
      if (cacheStatus.status === 'ready') {
        return sendCachedAppUpdateAsset(res, asset, cacheStatus);
      }
    }

    if (cacheAware) {
      const statusCode = cacheStatus.status === 'failed' ? 503 : 202;
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Retry-After', cacheStatus.status === 'failed' ? '30' : '2');
      res.setHeader('X-Update-Source', 'preload');
      return res.status(statusCode).json(buildClientCacheStatus(
        cacheStatus,
        buildGithubUpdateAssetUrls(asset, true).cacheStatusUrl
      ));
    }
  } catch (error) {
    console.warn('[Update Cache] 读取缓存状态失败，旧客户端回退实时代理:', error.message);
    if (cacheAware) return sendError(res, error, 503);
  }

  const controller = new AbortController();
  const untrack = trackUpdateAbortController(controller);
  let source = null;
  let completed = false;
  /** 清理旧客户端实时代理监听。 */
  const cleanupTransfer = () => {
    req.off?.('aborted', abortTransfer);
    res.off?.('close', abortTransfer);
    untrack();
  };
  /** 中断旧客户端实时代理。 */
  function abortTransfer() {
    if (completed) return;
    controller.abort('client closed');
    source?.destroy?.(new Error('客户端下载已中断'));
    cleanupTransfer();
  }
  req.on('aborted', abortTransfer);
  res.on('close', abortTransfer);

  try {
    const token = String(process.env.GITHUB_TOKEN || '').trim();
    const headers = {
      'User-Agent': 'yuyan-app',
      'Accept': 'application/octet-stream',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (req.headers.range) headers.Range = req.headers.range;
    if (req.headers['if-range']) headers['If-Range'] = req.headers['if-range'];

    console.log(`[Update Proxy] 旧客户端使用 GitHub 实时代理: ${asset.assetId} (${asset.filename})`);
    const response = await axios({
      method: 'get',
      url: `https://api.github.com/repos/${GITHUB_REPO}/releases/assets/${asset.assetId}`,
      responseType: 'stream',
      headers,
      signal: controller.signal,
      validateStatus: (status) => status === 200 || status === 206,
    });

    res.status(response.status);
    res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename=${encodeURIComponent(asset.filename)}`);
    res.setHeader('X-Update-Source', 'github-proxy-legacy');
    ['content-length', 'accept-ranges', 'content-range', 'etag', 'last-modified'].forEach((headerName) => {
      if (response.headers[headerName]) res.setHeader(headerName, response.headers[headerName]);
    });

    source = response.data;
    source.once('end', () => {
      completed = true;
      cleanupTransfer();
    });
    source.once('error', (error) => {
      if (controller.signal.aborted) return;
      cleanupTransfer();
      res.destroy(error);
    });
    source.pipe(res);
  } catch (error) {
    cleanupTransfer();
    if (controller.signal.aborted) return;
    console.error('[Update Proxy] 旧客户端代理资源失败:', error);
    let status = error.response?.status || 500;
    let errMsg = error.message || '中转下载失败';
    if (status === 401) errMsg = '下载时鉴权失败(401)，GitHub Token 无效';
    if (status === 404) errMsg = '未找到该安装包资源(404)，请检查发布版本是否正确';
    if (error.request && !error.response) errMsg = '中转下载失败，连接 GitHub 网络超时';
    return sendError(res, new Error(errMsg), status);
  }
}

/**
 * 执行目标级通用任务并复用发布进度协议。
 * @param {Object} req 请求
 * @param {Object} res 响应
 * @param {number} targetId 目标 ID
 * @param {string} action 任务动作
 * @param {(task: Object, emit: Object) => Promise<Object>} runner 执行器
 */
async function handleTargetOperationTask(req, res, targetId, action, runner) {
  if (!targetId) {
    sendError(res, new Error('部署目标 ID 无效'), 400);
    return;
  }
  const runningTask = deployTasksByTargetId.get(targetId);
  const streamMode = isStreamRequest(req);
  if (runningTask) {
    if (runningTask.action !== action) {
      sendDeployTargetBusy(res, runningTask);
      return;
    }
    await sendDeployTaskProgress(req, res, runningTask, streamMode);
    return;
  }
  if (deployTasksByTargetId.size >= MAX_RUNNING_DEPLOY_TASKS) {
    sendDeployLimitConflict(res);
    return;
  }
  const task = await createDeployTask(targetId, action, req.body || {});
  const emit = createProgressEmitter(task);
  deployTasksByTargetId.set(targetId, task);
  startDeployTask(task, async () => {
    const result = await runner(task, emit);
    emit.result(result);
    return result;
  }, emit);
  if (!streamMode) {
    try {
      res.json({ success: true, data: await task.promise });
    } catch (error) {
      sendError(res, error, 400);
    }
    return;
  }
  await sendDeployTaskProgress(req, res, task, true);
}

/** 检测后端项目配置。 */
export async function handleInspectBackendTarget(req, res) {
  try {
    const targetId = Number(req.params.id);
    const data = await inspectBackendTarget(targetId, {
      branch: req.body?.branch,
      gitlabToken: getGitlabTokenFromRequest(req),
      log: () => {},
    });
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/** 生成目标 OpenAPI。 */
export async function handleGenerateTargetOpenApi(req, res) {
  const targetId = Number(req.params.id);
  await handleTargetOperationTask(req, res, targetId, 'openapi', async (task, emit) => {
    emit.stage('clone', 10, '同步 OpenAPI 工作区', req.body?.branch || '目标默认分支');
    const artifact = await generateTargetOpenApi(targetId, {
      branch: req.body?.branch,
      force: Boolean(req.body?.force),
      gitlabToken: getGitlabTokenFromRequest(req),
      signal: task.controller.signal,
      log: (level, message, stage) => emit.log(level, message, stage),
    });
    emit.stage('finish', 100, 'OpenAPI 生成完成', artifact.fileName);
    return artifact;
  });
}

/** 获取目标最新 OpenAPI。 */
export async function handleGetLatestTargetOpenApi(req, res) {
  try {
    const artifact = await getLatestOpenApiArtifact(Number(req.params.id), String(req.query?.branch || ''), String(req.query?.commitSha || ''));
    if (!artifact) return sendError(res, new Error('当前目标暂无 OpenAPI 产物'), 404);
    res.json({ success: true, data: artifact });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/** 读取 OpenAPI 内容。 */
export async function handleReadOpenApiArtifact(req, res) {
  try {
    const artifact = await getOpenApiArtifact(Number(req.params.id));
    if (!artifact) return sendError(res, new Error('OpenAPI 产物不存在'), 404);
    const content = await fs.readFile(artifact.filePath, 'utf8');
    res.type('application/json').send(content);
  } catch (error) {
    sendError(res, error, 404);
  }
}

/** 下载 OpenAPI 文件。 */
export async function handleDownloadOpenApiArtifact(req, res) {
  try {
    const artifact = await getOpenApiArtifact(Number(req.params.id));
    if (!artifact) return sendError(res, new Error('OpenAPI 产物不存在'), 404);
    res.download(artifact.filePath, artifact.fileName);
  } catch (error) {
    sendError(res, error, 404);
  }
}

/** 获取后端服务真实状态。 */
export async function handleGetBackendServiceStatus(req, res) {
  try {
    res.json({ success: true, data: await getBackendServiceStatus(Number(req.params.id)) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/** 执行后端服务启停动作。 */
export async function handleRunBackendServiceAction(req, res) {
  const targetId = Number(req.params.id);
  const action = String(req.params.action || '');
  if (!['start', 'stop', 'restart'].includes(action)) {
    sendError(res, new Error('不支持的服务操作'), 400);
    return;
  }
  await handleTargetOperationTask(req, res, targetId, action, async (task, emit) => {
    emit.stage(action, 30, `${action} 后端服务`, '执行受控进程操作');
    const result = await runBackendServiceAction(targetId, action, {
      signal: task.controller.signal,
      log: (level, message, stage) => emit.log(level, message, stage),
    });
    emit.stage('finish', 100, '服务操作完成', result.status);
    return result;
  });
}

/** 读取后端服务日志。 */
export async function handleReadBackendServiceLogs(req, res) {
  try {
    res.json({ success: true, data: await readBackendServiceLogs(Number(req.params.id), Number(req.query?.lines || 500)) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/** 检测本机构建 JDK。 */
export async function handleTestJdk(req, res) {
  try {
    res.json({ success: true, data: await testBuildJdk(Number(req.params.id)) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/** 扫描本机已安装 JDK。 */
export async function handleScanLocalJdks(_req, res) {
  try {
    res.json({ success: true, data: await scanLocalBuildJdks() });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/** 获取服务器 Java 运行时。 */
export async function handleListServerJavaRuntimes(req, res) {
  try {
    res.json({ success: true, data: await listServerJavaRuntimes(Number(req.params.id)) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/** 新增服务器 Java 运行时。 */
export async function handleCreateServerJavaRuntime(req, res) {
  try {
    res.json({ success: true, data: await createServerJavaRuntime(Number(req.params.id), req.body || {}) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/** 扫描服务器 Java 运行时。 */
export async function handleScanServerJavaRuntimes(req, res) {
  try {
    res.json({ success: true, data: await scanServerJavaRuntimes(Number(req.params.id)) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/** 检测服务器 Java 运行时。 */
export async function handleTestServerJavaRuntime(req, res) {
  try {
    res.json({ success: true, data: await testServerJavaRuntime(Number(req.params.id)) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/** 删除服务器 Java 运行时。 */
export async function handleDeleteServerJavaRuntime(req, res) {
  try {
    res.json({ success: true, data: await deleteServerJavaRuntime(Number(req.params.id)) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/** 获取环境依赖配置列表。 */
export async function handleListDeployEnvironments(_req, res) {
  try {
    res.json({ success: true, data: await listDeployEnvironments() });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/** 新增环境依赖配置。 */
export async function handleCreateDeployEnvironment(req, res) {
  try {
    res.json({ success: true, data: await createDeployEnvironment(req.body || {}) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/** 更新环境依赖配置。 */
export async function handleUpdateDeployEnvironment(req, res) {
  try {
    const data = await updateDeployEnvironment(Number(req.params.id), req.body || {});
    if (!data) return sendError(res, new Error('环境依赖配置不存在'), 404);
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/** 删除环境依赖配置。 */
export async function handleDeleteDeployEnvironment(req, res) {
  try {
    res.json({ success: true, data: await deleteDeployEnvironment(Number(req.params.id)) });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 获取 JDK 列表
 */
export async function handleListJdks(req, res) {
  try {
    res.json({ success: true, data: await listJdks() });
  } catch (error) {
    sendError(res, error);
  }
}

/**
 * 新增 JDK 配置
 */
export async function handleCreateJdk(req, res) {
  try {
    const data = await createJdk(req.body || {});
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 更新 JDK 配置
 */
export async function handleUpdateJdk(req, res) {
  try {
    const id = Number(req.params.id);
    if (!id) throw new Error('无效的 JDK ID');
    const data = await updateJdk(id, req.body || {});
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error, 400);
  }
}

/**
 * 删除 JDK 配置
 */
export async function handleDeleteJdk(req, res) {
  try {
    const id = Number(req.params.id);
    if (!id) throw new Error('无效的 JDK ID');
    const data = await deleteJdk(id);
    res.json({ success: true, data });
  } catch (error) {
    sendError(res, error, 400);
  }
}
