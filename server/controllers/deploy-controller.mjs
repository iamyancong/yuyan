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
  listTargets,
  updateNginxInstance,
  updateServer,
  updateTarget,
  closeDeployDb,
  getDeployDb,
} from '../services/deploy-store.mjs';
import fs from 'node:fs/promises';
import fsSync, { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import axios from 'axios';
import { DEPLOY_DB_PATH } from '../config/constants.mjs';

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
  getNginxInstanceStatus,
  getNginxRuntimeStatus,
  initializeNginxInstanceRuntime,
  initializeNginxRuntime,
  runNginxInstanceAction,
  runNginxRuntimeAction,
  streamNginxInstanceArchive,
  syncTargetNginxSite,
} from '../services/nginx-runtime-service.mjs';

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
const STOPPABLE_DEPLOY_STAGE_KEYS = new Set(['validate', 'clone', 'install', 'build']);

/** 当前进程内正在执行的部署目标任务 */
const deployTasksByTargetId = new Map();

/**
 * 创建部署目标任务。
 * @param {number} targetId - 部署目标 ID
 * @param {'deploy'|'rollback'|'undoRollback'} action - 任务类型
 * @param {Object} body - 请求体
 * @returns {Object} 任务上下文
 */
function createDeployTask(targetId, action, body = {}) {
  return {
    targetId: Number(targetId),
    action,
    operator: String(body?.operator || '').trim() || '未知操作人',
    startedAt: new Date().toISOString(),
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
    .then((result) => {
      task.result = result;
      return result;
    })
    .catch((error) => {
      task.error = error instanceof Error ? error.message : String(error);
      if (!hasTaskErrorEvent(task)) emit.error(task.error, task.currentStage);
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
  res.status(409).json({
    success: false,
    error: `该部署目标正在${actionText}中，请稍后重试`,
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
    res.status(status).json({ success: false, error: message });
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
function validateTargetPayload(body) {
  if (body?.projectSource && !['ops', 'gitlab'].includes(String(body.projectSource))) throw new Error('项目来源不合法');
  if (!body?.projectId) throw new Error('项目 ID 必填');
  if (!body?.projectName) throw new Error('项目名称必填');
  if (!body?.repositoryUrl) throw new Error('仓库地址必填');
  if (!String(body?.defaultBranch || '').trim()) throw new Error('部署分支必填');
  if (!body?.serverId) throw new Error('部署服务器必填');
  if (!body?.nginxInstanceId) throw new Error('Nginx 实例必填');
  if (!String(body?.deployRoot || '').trim()) throw new Error('部署根目录必填');
  if (!String(body?.nginxConfPath || '').trim()) throw new Error('Nginx 配置文件路径必填');
  if (!String(body.deployRoot).trim().startsWith('/')) throw new Error('部署根目录必须使用服务器绝对路径');
  if (!String(body.nginxConfPath).trim().startsWith('/')) throw new Error('Nginx 配置文件路径必须使用服务器绝对路径');
  if (String(body.defaultBranch || '').includes('\n')) throw new Error('部署分支不能包含换行');
  if (String(body.artifactDir || '').includes('\n')) throw new Error('产物目录不能包含换行');
  if (String(body.preserveSubDirs || '').includes('\n')) throw new Error('保留子目录请使用逗号分隔，不能包含换行');
  if (body.uploadStrategy && !['cleanReplace', 'overlayKeepAssets'].includes(String(body.uploadStrategy))) throw new Error('资源上传策略不合法');
  if (body.nginxSiteManaged) {
    const listenPort = Number(body.listenPort || 0);
    if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) throw new Error('托管站点监听端口必须在 1-65535 之间');
    if (String(body.serverName || '').includes('\n')) throw new Error('server_name 不能包含换行');
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
    const result = await deleteServer(Number(req.params.id));
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

/**
 * 下载托管 Nginx 实例运行包。
 */
export async function handleDownloadNginxInstanceArchive(req, res) {
  try {
    await streamNginxInstanceArchive(Number(req.params.id), res, ({ fileName, baseRoot, scriptPath }) => {
      res.status(200);
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('X-Nginx-Base-Root', encodeURIComponent(baseRoot || ''));
      res.setHeader('X-Nginx-Script-Path', encodeURIComponent(scriptPath || ''));
      res.flushHeaders?.();
    });
    if (!res.writableEnded) res.end();
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    sendError(res, error, 400);
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

/**
 * 创建部署目标
 */
export async function handleCreateTarget(req, res) {
  try {
    validateTargetPayload(req.body);
    res.json({
      success: true,
      data: await createTarget({
        ...req.body,
        projectSource: req.body.projectSource === 'gitlab' ? 'gitlab' : 'ops',
        envName: req.body.envName || '测试',
        installCommand: normalizeCommandText(req.body.installCommand) || 'pnpm install',
        buildCommand: normalizeCommandText(req.body.buildCommand) || 'pnpm build',
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
    validateTargetPayload(req.body);
    const target = await updateTarget(Number(req.params.id), {
      ...req.body,
      projectSource: req.body.projectSource === 'gitlab' ? 'gitlab' : 'ops',
      envName: req.body.envName || '测试',
      installCommand: normalizeCommandText(req.body.installCommand) || 'pnpm install',
      buildCommand: normalizeCommandText(req.body.buildCommand) || 'pnpm build',
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
    const result = await deleteTarget(Number(req.params.id));
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

  const task = createDeployTask(targetId, 'deploy', req.body || {});
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
  if (task.action !== 'deploy') {
    sendError(res, new Error('当前任务不支持停止'), 400);
    return;
  }
  if (!STOPPABLE_DEPLOY_STAGE_KEYS.has(task.currentStage)) {
    sendError(res, new Error('上传产物后不可停止当前发布任务'), 400);
    return;
  }
  task.controller.abort(new DeployStoppedError('用户已停止发布任务'));
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
  const task = createDeployTask(sourceRecord.targetId, action, req.body || {});
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

// 自动更新后台任务状态与进度
let appUpdateStatus = {
  status: 'idle', // 'idle' | 'downloading' | 'completed' | 'error'
  progress: 0,
  error: null,
  localPath: null
};

/**
 * 获取自动更新当前下载状态和进度
 */
export async function handleGetAppUpdateStatus(req, res) {
  res.json(appUpdateStatus);
}

/**
 * 触发后台静默下载并拉起更新程序（已加入防挂起超时保护）
 */
export async function handleDownloadAppUpdate(req, res) {
  const { url, filename } = req.body;
  if (!url || !filename) {
    return sendError(res, new Error('缺少必要参数 url 或 filename'), 400);
  }

  if (appUpdateStatus.status === 'downloading') {
    return res.json({ success: true, message: '下载正在进行中' });
  }

  appUpdateStatus = {
    status: 'downloading',
    progress: 0,
    error: null
  };

  // 异步下载，立即返回
  res.json({ success: true, message: '开始后台下载更新包...' });

  try {
    const tempDir = os.tmpdir();
    const destPath = path.join(tempDir, filename);

    // Token 统一从服务端环境变量获取
    const token = process.env.GITHUB_TOKEN || '';
    const headers = {
      'User-Agent': 'yuyan-app'
    };

    if (token && token.trim() !== '') {
      headers['Authorization'] = `Bearer ${token.trim()}`;
    }

    // 自适应判断如果是 GitHub Release 资源下载
    if (url.includes('api.github.com') && url.includes('/assets/')) {
      headers['Accept'] = 'application/octet-stream';
    }

    console.log(`[bootstrap-update] 后台下载启动: ${url} -> ${destPath}`);

    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream',
      headers: headers
    });

    const totalLength = parseInt(response.headers['content-length'], 10) || 0;
    let downloadedLength = 0;

    const writer = createWriteStream(destPath);

    // 防挂起超时保护：20 秒内未收到新数据则判定为连接中断
    let stallTimer = null;
    const STALL_TIMEOUT_MS = 20000;

    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        console.error(`[bootstrap-update] 下载超时中断：${STALL_TIMEOUT_MS / 1000} 秒内未收到新数据`);
        response.data.destroy();
        writer.destroy();
        appUpdateStatus.status = 'error';
        appUpdateStatus.error = `下载超时中断：${STALL_TIMEOUT_MS / 1000} 秒内未收到新数据，请检查网络连接后重试`;
      }, STALL_TIMEOUT_MS);
    };

    resetStallTimer();
    response.data.pipe(writer);

    response.data.on('data', (chunk) => {
      downloadedLength += chunk.length;
      if (totalLength > 0) {
        appUpdateStatus.progress = Math.round((downloadedLength / totalLength) * 100);
      }
      resetStallTimer();
    });

    writer.on('finish', () => {
      if (stallTimer) clearTimeout(stallTimer);
      console.log(`[bootstrap-update] 下载成功！更新包已暂存为: ${destPath}`);
      appUpdateStatus.status = 'completed';
      appUpdateStatus.progress = 100;
      appUpdateStatus.localPath = destPath;
    });

    writer.on('error', (err) => {
      if (stallTimer) clearTimeout(stallTimer);
      console.error('[bootstrap-update] 文件写入失败:', err);
      appUpdateStatus.status = 'error';
      appUpdateStatus.error = `保存安装包时发生错误: ${err.message}`;
    });

    response.data.on('error', (err) => {
      if (stallTimer) clearTimeout(stallTimer);
      console.error('[bootstrap-update] 数据流接收异常:', err);
      writer.destroy();
      appUpdateStatus.status = 'error';
      appUpdateStatus.error = `下载数据流中断: ${err.message}`;
    });

  } catch (err) {
    console.error('[bootstrap-update] 下载时捕获到异常:', err);
    appUpdateStatus.status = 'error';
    appUpdateStatus.error = `下载异常: ${err.message}`;
  }
}

/**
 * 触发执行已下载的更新包进行安装
 */
export async function handleInstallAppUpdate(req, res) {
  if (appUpdateStatus.status !== 'completed' || !appUpdateStatus.localPath) {
    return sendError(res, new Error('更新包尚未下载完成，无法执行安装'), 400);
  }

  const destPath = appUpdateStatus.localPath;

  try {
    let command = '';
    if (process.platform === 'win32') {
      command = `start "" "${destPath}"`;
    } else if (process.platform === 'darwin') {
      command = `open "${destPath}"`;
    } else {
      command = `xdg-open "${destPath}"`;
    }

    console.log(`[bootstrap-update] 用户触发安装：拉起更新包 ${destPath}`);
    exec(command, (err) => {
      if (err) {
        console.error('[bootstrap-update] 运行安装程序失败:', err);
        return sendError(res, new Error(`拉起安装程序失败: ${err.message}`), 500);
      }
    });

    res.json({ success: true, message: '已拉起安装程序，正在覆盖升级' });
  } catch (err) {
    console.error('[bootstrap-update] 拉起安装程序捕获到异常:', err);
    sendError(res, err, 500);
  }
}

/**
 * 语义化版本号比对，判断 remote 是否比 local 新
 */
function isNewerVersion(local, remote) {
  const l = local.replace(/^v/, '');
  const r = remote.replace(/^v/, '');
  
  if (l === r) return false;
  
  const [lMain, lPre] = l.split('-');
  const [rMain, rPre] = r.split('-');
  
  const lParts = lMain.split('.').map(Number);
  const rParts = rMain.split('.').map(Number);
  
  for (let i = 0; i < Math.max(lParts.length, rParts.length); i++) {
    const lNum = lParts[i] || 0;
    const rNum = rParts[i] || 0;
    if (rNum > lNum) return true;
    if (lNum > rNum) return false;
  }
  
  // 预发布版本 (Prerelease) 判定逻辑
  if (rPre && !lPre) {
    // 在开发测试阶段，如果主版本号相同但远程是带有预发布后缀的分支构建包（如 1.0.0-hash），允许更新
    return true;
  }
  if (!rPre && lPre) return true;
  if (rPre && lPre && rPre !== lPre) return true;
  
  return false;
}

// 预下载和缓存管理器，防止并发重复下载
const activePreloads = new Set();

/**
 * 校验缓存文件是否为有效的系统安装包
 * @param {string} filePath 缓存文件路径
 * @param {string} filename 安装包文件名
 * @returns {boolean} 文件大小和格式签名是否有效
 */
function isValidUpdateAssetFile(filePath, filename = '') {
  try {
    const stats = fsSync.statSync(filePath);
    if (!stats.isFile() || stats.size <= 1024 * 1024) return false;

    const extension = path.extname(filename).toLowerCase();
    const descriptor = fsSync.openSync(filePath, 'r');
    try {
      if (extension === '.exe') {
        const header = Buffer.alloc(2);
        fsSync.readSync(descriptor, header, 0, header.length, 0);
        return header.equals(Buffer.from('MZ'));
      }
      if (extension === '.dmg') {
        if (stats.size < 512) return false;
        const trailer = Buffer.alloc(4);
        fsSync.readSync(descriptor, trailer, 0, trailer.length, stats.size - 512);
        return trailer.equals(Buffer.from('koly'));
      }
      return false;
    } finally {
      fsSync.closeSync(descriptor);
    }
  } catch (error) {
    console.warn(`[Update Cache] 校验安装包失败: ${filePath}`, error.message);
    return false;
  }
}

/**
 * 在后台预下载 GitHub Release 安装包并缓存到本地目录
 */
async function preloadAndCacheAsset(assetId, filename) {
  const token = process.env.GITHUB_TOKEN || '';
  if (!token) return;

  const cacheDir = path.join(process.env.DEPLOY_DATA_DIR || '/data/yuyan-ops/deploy-data', 'app-update-cache');
  const cachePath = path.join(cacheDir, `${assetId}-${filename}`);

  // 1. 确保缓存目录存在
  if (!fsSync.existsSync(cacheDir)) {
    try {
      fsSync.mkdirSync(cacheDir, { recursive: true });
    } catch (err) {
      console.error('[Update Cache] 创建缓存目录失败:', err);
      return;
    }
  }

  // 2. 如果已经存在且格式有效，则跳过；损坏缓存立即清理
  if (fsSync.existsSync(cachePath)) {
    if (isValidUpdateAssetFile(cachePath, filename)) {
      const stats = fsSync.statSync(cachePath);
      console.log(`[Update Cache] 缓存包已存在且格式有效: ${cachePath} (${(stats.size/1024/1024).toFixed(2)}MB)，无需预下载`);
      return;
    }
    console.warn(`[Update Cache] 检测到损坏缓存，立即清理: ${cachePath}`);
    try { fsSync.unlinkSync(cachePath); } catch (e) {}
  }

  // 3. 避免并发重复下载
  if (activePreloads.has(assetId)) {
    return;
  }
  activePreloads.add(assetId);

  console.log(`[Update Cache] 开始静默预下载 GitHub Release 资源: ${assetId} -> ${cachePath}`);

  const tempCachePath = `${cachePath}.preload-${process.pid}-${Date.now()}.tmp`;
  try {
    const url = `https://api.github.com/repos/ycwang-dev/yuyan/releases/assets/${assetId}`;
    const headers = {
      'User-Agent': 'yuyan-app',
      'Accept': 'application/octet-stream',
      'Authorization': `Bearer ${token.trim()}`
    };

    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream',
      headers: headers,
      timeout: 300000 // 5分钟超时
    });

    const writer = fsSync.createWriteStream(tempCachePath);

    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
      response.data.on('error', reject);
    });

    if (!isValidUpdateAssetFile(tempCachePath, filename)) {
      throw new Error('预下载文件格式校验失败，不是有效安装包');
    }

    // 下载成功并校验后重命名为正式缓存文件
    fsSync.renameSync(tempCachePath, cachePath);
    console.log(`[Update Cache] 资源预下载并缓存成功: ${cachePath}`);
  } catch (err) {
    console.error(`[Update Cache] 资源预下载失败:`, err.message);
    if (fsSync.existsSync(tempCachePath)) {
      try { fsSync.unlinkSync(tempCachePath); } catch (e) {}
    }
  } finally {
    activePreloads.delete(assetId);
  }
}

/**
 * 自动更新版本检测（统一通过服务端环境变量 GITHUB_TOKEN 代理访问 GitHub API）
 */
export async function handleCheckAppUpdate(req, res) {
  const { currentVersion, platform } = req.query;
  if (!currentVersion) {
    return sendError(res, new Error('缺少必要参数 currentVersion'), 400);
  }

  try {
    // Token 统一从服务端环境变量获取
    const token = process.env.GITHUB_TOKEN || '';
    const headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'yuyan-app'
    };

    if (token && token.trim() !== '') {
      headers['Authorization'] = `Bearer ${token.trim()}`;
    }

    // 从 GitHub 获取 Releases 列表
    const response = await axios.get('https://api.github.com/repos/ycwang-dev/yuyan/releases', { headers });
    const data = response.data;

    if (!Array.isArray(data) || data.length === 0) {
      return res.json({ hasUpdate: false, message: '暂无版本发布信息' });
    }

    const latestRelease = data[0];
    const remoteVersion = latestRelease.tag_name;

    if (isNewerVersion(currentVersion, remoteVersion)) {
      const assets = latestRelease.assets || [];
      let targetAsset = null;

      const isMac = platform === 'darwin' || platform === 'mac';
      if (isMac) {
        targetAsset = assets.find(a => a.name.endsWith('.dmg'));
      } else {
        targetAsset = assets.find(a => a.name.endsWith('.exe'));
      }

      if (!targetAsset) {
        return res.json({ hasUpdate: false, message: '当前有新版本，但未找到匹配您系统的安装包资源' });
      }

      // 重写下载链接为内网服务器的免密中转链接（Token 由服务端环境变量管理，无需拼入 URL）
      const filename = targetAsset.name;
      const downloadUrl = `/deploy-api/app-update/download-asset?assetId=${targetAsset.id}&filename=${filename}`;

      // 触发后台预下载（静默执行，不阻塞 check 接口的响应）
      preloadAndCacheAsset(targetAsset.id, filename).catch(err => {
        console.error('[Update Cache] 预下载启动异常:', err);
      });

      res.json({
        hasUpdate: true,
        latestVersion: remoteVersion.replace(/^v/, ''),
        updateLogs: latestRelease.body || '无更新说明。',
        downloadUrl: downloadUrl
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

/**
 * 代理下载 GitHub Release Asset 资源，并将二进制流通过 pipe 实时中转给本地客户端（Token 由服务端环境变量统一管理）
 */
export async function handleDownloadAppUpdateAsset(req, res) {
  const { assetId, filename } = req.query;
  if (!assetId) {
    return sendError(res, new Error('缺少必要参数 assetId'), 400);
  }

  try {
    const cacheDir = path.join(process.env.DEPLOY_DATA_DIR || '/data/yuyan-ops/deploy-data', 'app-update-cache');
    const cachePath = path.join(cacheDir, `${assetId}-${filename || 'update'}`);

    // 1. 如果命中有效缓存则直接返回；损坏缓存先清理再回源
    if (fsSync.existsSync(cachePath)) {
      if (isValidUpdateAssetFile(cachePath, filename)) {
        const stats = fsSync.statSync(cachePath);
        console.log(`[Update Cache] 命中缓存，直接返回本地缓存包: ${cachePath} (${(stats.size/1024/1024).toFixed(2)}MB)`);

        res.setHeader('Content-Length', stats.size);
        res.setHeader('Content-Type', 'application/octet-stream');
        if (filename) {
          res.setHeader('Content-Disposition', `attachment; filename=${encodeURIComponent(filename)}`);
        }

        const fileStream = fsSync.createReadStream(cachePath);
        fileStream.pipe(res);
        return;
      }
      console.warn(`[Update Cache] 命中损坏缓存，删除后回源下载: ${cachePath}`);
      try { fsSync.unlinkSync(cachePath); } catch (e) {}
    }

    // 2. 缓存未命中，实时从中转下载，并且同步写入缓存
    const token = process.env.GITHUB_TOKEN || '';
    const headers = {
      'User-Agent': 'yuyan-app',
      'Accept': 'application/octet-stream'
    };

    if (token && token.trim() !== '') {
      headers['Authorization'] = `Bearer ${token.trim()}`;
    }

    const url = `https://api.github.com/repos/ycwang-dev/yuyan/releases/assets/${assetId}`;
    console.log(`[Update Proxy] 缓存未命中，内网服务器代理下载私有资源: ${assetId} (文件名: ${filename})`);

    const response = await axios({
      method: 'get',
      url: url,
      responseType: 'stream',
      headers: headers
    });

    res.setHeader('Content-Length', response.headers['content-length']);
    res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
    if (filename) {
      res.setHeader('Content-Disposition', `attachment; filename=${encodeURIComponent(filename)}`);
    }

    // 尝试在本地保存一份缓存
    let cacheWriter = null;
    const tempCachePath = `${cachePath}.proxy-${process.pid}-${Date.now()}.tmp`;
    try {
      if (!fsSync.existsSync(cacheDir)) {
        fsSync.mkdirSync(cacheDir, { recursive: true });
      }
      cacheWriter = fsSync.createWriteStream(tempCachePath);
    } catch (e) {
      console.error('[Update Cache] 创建缓存写入流失败，仅执行实时中转:', e.message);
    }

    // 手动分流：避免对同一 Readable 流执行两次 pipe() 导致背压死锁
    // 使用 data/end/error 事件手动将数据分发到 res 和 cacheWriter
    const source = response.data;

    source.on('data', (chunk) => {
      // 1. 写入 HTTP 响应流（优先保证客户端接收）
      const resOk = res.write(chunk);
      // 2. 写入本地缓存文件（非阻塞，忽略背压以避免影响主流程）
      if (cacheWriter && !cacheWriter.destroyed) {
        cacheWriter.write(chunk);
      }
      // 仅在 res 需要背压控制时暂停源流
      if (!resOk) {
        source.pause();
        res.once('drain', () => source.resume());
      }
    });

    source.on('end', () => {
      res.end();
      if (cacheWriter && !cacheWriter.destroyed) {
        cacheWriter.end(() => {
          // 下载完整并通过格式校验后，将独立临时文件重命名为正式缓存
          try {
            if (!isValidUpdateAssetFile(tempCachePath, filename)) {
              throw new Error('代理下载文件格式校验失败，不写入缓存');
            }
            fsSync.renameSync(tempCachePath, cachePath);
            console.log(`[Update Cache] 代理下载的同时成功将文件写入缓存: ${cachePath}`);
          } catch (renameErr) {
            console.error('[Update Cache] 重命名缓存文件失败:', renameErr);
            try { fsSync.unlinkSync(tempCachePath); } catch (e) {}
          }
        });
      }
    });

    source.on('error', (err) => {
      console.error('[Update Proxy] 源数据流错误:', err);
      res.destroy(err);
      if (cacheWriter && !cacheWriter.destroyed) {
        cacheWriter.destroy();
        try { fsSync.unlinkSync(tempCachePath); } catch (e) {}
      }
    });

    if (cacheWriter) {
      cacheWriter.on('error', (err) => {
        console.error('[Update Cache] 代理写入缓存文件出错:', err);
        cacheWriter.destroy();
        try { fsSync.unlinkSync(tempCachePath); } catch (e) {}
      });
    }
  } catch (error) {
    console.error('[Update Proxy] 代理资源流失败:', error);
    let status = 500;
    let errMsg = error.message;
    if (error.response) {
      status = error.response.status;
      errMsg = `GitHub 响应错误: ${error.response.statusText || status} (${status})`;
      if (status === 401) errMsg = '下载时鉴权失败(401)，GitHub Token 无效';
      if (status === 404) errMsg = '未找到该安装包资源(404)，请检查发布版本是否正确';
    } else if (error.request) {
      errMsg = '中转下载失败，连接 GitHub 网络超时';
    }
    sendError(res, new Error(errMsg), status);
  }
}
