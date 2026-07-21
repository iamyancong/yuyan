#!/usr/bin/env node
/**
 * Scaffold 服务入口
 * @description Express 应用初始化、中间件配置、路由注册、服务启动
 */

import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import cors from 'cors';
import history from 'connect-history-api-fallback';
import compression from 'compression';
import {
  PORT,
  CLIENT_DIST,
  TEMPLATE_REPO_PATH,
  TEMPLATE_REPO_URL,
  TEMPLATE_BRANCH,
  DEPLOY_DB_PATH,
  APP_UPDATE_DIR,
  DEPLOY_ALLOWED_ORIGINS,
  DEPLOY_API_TOKEN,
  DEPLOY_BIND_HOST,
  AGENT_SESSION_TOKEN,
} from './config/constants.mjs';
import { pullLatestTemplate, validateTemplate } from './services/template-service.mjs';
import { startCleanupScheduler } from './utils/cleanup-scheduler.mjs';
import scaffoldRoutes from './routes/scaffold.mjs';
import deployRoutes from './routes/deploy.mjs';
import healthRoutes from './routes/health.mjs';
import agentRoutes from './routes/agent.mjs';
import authV2Routes from './routes/auth-v2.mjs';
import { appendCentralAudit, authorizeCentralV2 } from './services/central-identity-service.mjs';
import { guardCentralDeployRequest } from './services/central-deploy-guard.mjs';
import { getRequestContext } from './services/request-context.mjs';
import { closeDeployDb, getDeployDb } from './services/deploy-store.mjs';
import { closeAgentDb, getAgentDb } from './services/agent-store.mjs';
import { timingSafeTokenEqual } from './services/agent-security.mjs';
import { abortAppUpdateTransfers } from './controllers/deploy-controller.mjs';
import { startAppUpdatePreloadScheduler } from './services/app-update-release-service.mjs';

// 创建 Express 应用
const app = express();
let httpServer = null;
let stopCleanupScheduler = null;
let stopUpdatePreloadScheduler = null;
let shuttingDown = false;
const activeSockets = new Set();
const isTauriSubprocess = process.env.IS_TAURI_SUBPROCESS === 'true';
const isLoopbackBind = ['127.0.0.1', '::1', 'localhost'].includes(DEPLOY_BIND_HOST);

/** 比较部署 API 令牌，避免普通字符串比较泄露时序差异。 */
function isValidDeployToken(value) {
  const actual = Buffer.from(String(value || ''));
  const expected = Buffer.from(DEPLOY_API_TOKEN);
  return actual.length === expected.length && actual.length > 0 && crypto.timingSafeEqual(actual, expected);
}

/** 判断是否为兼容旧版客户端的免鉴权更新包下载请求。 */
function isPublicAppUpdateDownload(req) {
  return req.method === 'GET' && [
    '/app-update/download-asset',
    '/app-update/check',
    '/app-update/cache-status',
  ].includes(req.path) || (req.method === 'GET' && req.path.startsWith('/app-update/tauri/'));
}

/** 非本机部署 API 鉴权中间件。 */
function authorizeDeployApi(req, res, next) {
  if (isLoopbackBind || isTauriSubprocess || isPublicAppUpdateDownload(req)) return next();
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = String(req.headers['x-deploy-token'] || bearer);
  if (!isValidDeployToken(token)) {
    res.status(401).json({ success: false, error: '部署 API 鉴权失败' });
    return;
  }
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.status(410).json({
      success: false,
      error: {
        code: 'legacy_api_read_only',
        message: '旧共享 Token API 已进入只读兼容，请升级客户端并使用 /deploy-api/v2',
        retryable: false,
      },
    });
    return;
  }
  next();
}

/** 仅允许持有本次启动令牌的本机 MCP Sidecar 与雨燕 WebView 访问 Agent Gateway。 */
function authorizeAgentApi(req, res, next) {
  if (!isTauriSubprocess || !AGENT_SESSION_TOKEN) {
    res.status(503).json({ success: false, error: { code: 'agent_gateway_unavailable', message: 'Agent Gateway 仅在雨燕桌面端启用', retryable: true } });
    return;
  }
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = String(req.headers['x-yuyan-agent-token'] || bearer);
  if (!timingSafeTokenEqual(token, AGENT_SESSION_TOKEN)) {
    res.status(401).json({ success: false, error: { code: 'authorization_failed', message: 'Agent Gateway 会话令牌无效', retryable: true } });
    return;
  }
  next();
}

/** 远程脚手架接口复用短期账号身份与设备会话门禁。 */
function authorizeScaffoldApi(req, res, next) {
  if (isLoopbackBind || isTauriSubprocess) return next();
  authorizeCentralV2(req, res, () => {
    const context = getRequestContext();
    const adminOnly = req.method === 'POST' && req.path.startsWith('/ops/');
    const writeRequest = !['GET', 'HEAD'].includes(req.method);
    const allowed = adminOnly ? context.role === 'admin' : !writeRequest || ['operator', 'admin'].includes(context.role);
    if (!allowed) {
      res.status(403).json({ success: false, error: { code: 'forbidden_role', message: '当前账号无权执行脚手架操作', retryable: false } });
      return;
    }
    if (writeRequest) {
      res.once('finish', () => {
        if (res.statusCode < 400) void appendCentralAudit(context, { action: `${req.method} /scaffold-api${req.path}`, result: 'accepted' }).catch(() => undefined);
      });
    }
    next();
  });
}

// 中间件配置
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      const localOrigin = /^(?:https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?|https?:\/\/tauri\.localhost|tauri:\/\/localhost)$/i.test(origin);
      const allowed = localOrigin || DEPLOY_ALLOWED_ORIGINS.includes(origin);
      callback(allowed ? null : new Error('当前来源不允许调用雨燕服务'), allowed);
    },
    credentials: true,
  })
);
app.use((error, _req, res, next) => {
  if (error?.message === '当前来源不允许调用雨燕服务') {
    res.status(403).json({ success: false, error: error.message });
    return;
  }
  next(error);
});
app.use(express.json({ limit: '2mb' }));

// 健康检查路由
app.use('/health', healthRoutes);

/** 桌面端安装包静态分发，原生支持 Range、ETag 和断点续传。 */
app.use(
  '/app-updates',
  express.static(APP_UPDATE_DIR, {
    acceptRanges: true,
    etag: false,
    fallthrough: false,
    immutable: true,
    lastModified: true,
    maxAge: '1y',
    setHeaders: (res, filePath) => {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      try {
        const sha256 = fs.readFileSync(`${filePath}.sha256`, 'utf8').trim();
        if (/^[a-f0-9]{64}$/i.test(sha256)) {
          res.setHeader('ETag', `"sha256-${sha256.toLowerCase()}"`);
        }
      } catch {}
    },
  })
);

// 脚手架 API 路由
app.use('/scaffold-api', authorizeScaffoldApi, scaffoldRoutes);

// 多用户、多设备身份与会话接口
app.use('/api/v2', authV2Routes);

// 中央 v2 部署接口必须使用短期雨燕令牌和账号隔离上下文
app.use('/deploy-api/v2', authorizeCentralV2, guardCentralDeployRequest, deployRoutes);

// 独立服务器部署 API 路由
app.use('/deploy-api', authorizeDeployApi, deployRoutes);

// AI 控制平面内部网关，永不复用普通部署 API 的免鉴权规则
app.use('/agent-api/v1', authorizeAgentApi, agentRoutes);

// SPA history 回退（Express 5 兼容），排除接口与健康检查
try {
  app.use(
    history({
      htmlAcceptHeaders: ['text/html', 'application/xhtml+xml'],
      disableDotRule: true,
      rewrites: [{ from: /^\/(api|scaffold-api|deploy-api|agent-api|app-updates|health)(?:\/|$)/, to: (ctx) => ctx.parsedUrl.pathname }],
    })
  );
} catch {}

/** 不参与静态资源压缩的路由前缀，避免接口流式响应被缓冲 */
const noStaticCompressionRoutePattern = /^\/(?:api|scaffold-api|deploy-api|agent-api|app-updates|health)(?:\/|$)/;

/**
 * 判断当前响应是否允许静态资源压缩。
 * @param {import('express').Request} req - Express 请求
 * @param {import('express').Response} res - Express 响应
 * @returns {boolean} 是否允许压缩
 */
function shouldCompressStaticResponse(req, res) {
  if (req.headers['x-no-compression']) return false;
  if (noStaticCompressionRoutePattern.test(req.path)) return false;

  const contentType = String(res.getHeader('Content-Type') || '');
  if (contentType.includes('application/x-ndjson') || contentType.includes('text/event-stream')) return false;

  return compression.filter(req, res);
}

// 静态托管前端（放在 history 之后）
try {
  app.use(
    '/',
    compression({
      filter: shouldCompressStaticResponse,
    })
  );
  app.use(
    '/',
    express.static(CLIENT_DIST, {
      fallthrough: true,
      index: 'index.html',
      extensions: ['html'],
      setHeaders: (res, filePath) => {
        // Vite build 产物通常是带 hash 的文件，可长期缓存；index.html 不建议强缓存
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
          return;
        }

        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    })
  );
} catch {}

/** API 统一异常兜底，避免 Express 默认 HTML 错误页泄露实现细节。 */
app.use((error, req, res, next) => {
  if (!/^\/(?:api|scaffold-api|deploy-api|agent-api|health)(?:\/|$)/.test(req.path)) {
    next(error);
    return;
  }
  const status = Number(error?.status || 500);
  res.status(status).json({
    success: false,
    error: {
      code: String(error?.code || 'internal_error'),
      message: status >= 500 && !error?.code ? '雨燕服务暂时不可用' : String(error?.message || '请求失败'),
      retryable: status >= 500,
    },
  });
});

/**
 * 启用子进程生命周期守护与自毁机制
 * @description 当父进程（Tauri 客户端）异常退出、被强杀或崩溃时，Node 服务能自动退出，避免残留僵尸进程占用端口
 */
function setupSelfDestruct() {
  // 仅在作为子进程启动（由主程序传入关键环境变量）时启用，避免影响命令行手动调试
  if (process.env.IS_TAURI_SUBPROCESS !== 'true') {
    return;
  }

  console.log('[SelfDestruct] 已启用主进程生命周期守护自毁机制');

  // 1. 激活 stdin 管道监听。当主程序崩溃或退出时，系统会自动关闭管道，触发 'end' 事件
  try {
    process.stdin.resume();
    process.stdin.on('end', () => {
      console.log('[SelfDestruct] 检测到父进程已关闭标准输入管道，正在自毁退出 Node 服务...');
      void shutdown('stdin end');
    });
  } catch (error) {
    console.warn('[SelfDestruct] 激活 stdin 监听失败:', error);
  }

  // 2. 定时心跳轮询检测父进程存活状态（作为 stdin 管道在某些平台失效时的兜底）
  if (process.ppid) {
    setInterval(() => {
      try {
        // 向父进程 PID 发送 0 信号用于探测其是否存活，若不存在会抛出错误
        process.kill(process.ppid, 0);
      } catch {
        console.log(`[SelfDestruct] 检测到父进程 (PID: ${process.ppid}) 已不存在，正在自毁退出 Node 服务...`);
        void shutdown('parent missing');
      }
    }, 5000).unref(); // 使用 unref 避免该定时器阻止进程因其他正常原因退出
  }
}

/**
 * 初始化模板仓库。
 * @returns {Promise<boolean>} 模板是否可用
 */
async function initializeTemplateRepository() {
  console.log('[bootstrap] 正在初始化模板仓库...');
  const success = await pullLatestTemplate();

  if (!success) {
    console.warn('[bootstrap] ⚠️ 模板初始化失败，服务将继续启动，但创建项目可能会失败');
    console.warn('[bootstrap] 请检查：');
    console.warn('[bootstrap]   1. GITLAB_TOKEN 环境变量是否正确设置');
    console.warn('[bootstrap]   2. 模板仓库 URL 是否可访问');
    console.warn('[bootstrap]   3. 网络连接是否正常');
    return false;
  }

  const isValid = await validateTemplate();
  if (isValid) {
    console.log('[bootstrap] ✅ 模板初始化成功，脚本已就绪');
  } else {
    console.error('[bootstrap] ❌ 模板目录存在但脚本文件缺失');
    console.error('[bootstrap] 请检查模板仓库结构是否正确');
  }
  return isValid;
}

/**
 * 统一关闭 HTTP 服务、后台任务、下载流和 SQLite 连接。
 * @param {string} reason - 关闭原因
 */
async function shutdown(reason = 'unknown') {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] 收到关闭信号: ${reason}`);

  try {
    abortAppUpdateTransfers(reason);
  } catch (error) {
    console.warn('[shutdown] 中断更新下载任务失败:', error);
  }

  try {
    stopCleanupScheduler?.();
    stopCleanupScheduler = null;
  } catch (error) {
    console.warn('[shutdown] 停止清理任务失败:', error);
  }

  try {
    stopUpdatePreloadScheduler?.();
    stopUpdatePreloadScheduler = null;
  } catch (error) {
    console.warn('[shutdown] 停止更新包预热任务失败:', error);
  }

  await new Promise((resolve) => {
    if (!httpServer) {
      resolve();
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    httpServer.close((error) => {
      if (error) console.warn('[shutdown] HTTP 服务关闭异常:', error);
      finish();
    });
    for (const socket of activeSockets) {
      socket.end();
    }
    setTimeout(() => {
      for (const socket of activeSockets) {
        socket.destroy();
      }
      finish();
    }, 3000).unref?.();
  });

  try {
    closeDeployDb();
  } catch (error) {
    console.warn('[shutdown] 关闭 SQLite 连接失败:', error);
  }

  try {
    closeAgentDb();
  } catch (error) {
    console.warn('[shutdown] 关闭 Agent SQLite 连接失败:', error);
  }

  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

/**
 * 服务启动入口
 */
async function bootstrap() {
  // 启动生命周期守护
  setupSelfDestruct();

  try {
    console.log('='.repeat(60));
    console.log(`🚀 Scaffold 服务启动中...`);
    console.log(`📂 模板路径: ${TEMPLATE_REPO_PATH}`);
    console.log(`🔗 模板仓库: ${TEMPLATE_REPO_URL}`);
    console.log(`🌿 模板分支: ${TEMPLATE_BRANCH}`);
    console.log('='.repeat(60));

    if (!isLoopbackBind && !isTauriSubprocess) {
      if (!DEPLOY_API_TOKEN) throw new Error('服务绑定非本机地址时必须配置 DEPLOY_API_TOKEN');
      if (!DEPLOY_ALLOWED_ORIGINS.length) throw new Error('服务绑定非本机地址时必须配置 DEPLOY_ALLOWED_ORIGINS');
    }
    if (!isTauriSubprocess) {
      await initializeTemplateRepository();
    }

    // 启动定时清理任务
    stopCleanupScheduler = startCleanupScheduler();
    if (!isTauriSubprocess) {
      stopUpdatePreloadScheduler = startAppUpdatePreloadScheduler();
    }

    // 初始化独立服务器部署数据库
    await getDeployDb();
    console.log(`[bootstrap] ✅ 独立服务器部署数据库已就绪: ${DEPLOY_DB_PATH}`);
    if (isTauriSubprocess && AGENT_SESSION_TOKEN) {
      getAgentDb();
      console.log('[bootstrap] ✅ AI 控制平面数据库与 Agent Gateway 已就绪');
    }

    // 根据运行环境动态选择监听地址：
    // - Tauri 桌面端：绑定 127.0.0.1 防止局域网外部访问并规避 Windows 防火墙弹窗
    // - Docker/服务器端：绑定 0.0.0.0 允许容器外部（反向代理/Docker 网络）正常访问
    const BIND_HOST = isTauriSubprocess ? '127.0.0.1' : DEPLOY_BIND_HOST;
    httpServer = app.listen(PORT, BIND_HOST, () => {
      console.log('='.repeat(60));
      console.log(`🚀 Scaffold 服务启动成功!`);
      console.log(`📍 服务地址: http://${BIND_HOST}:${PORT}`);
      console.log(`💚 健康检查: http://${BIND_HOST}:${PORT}/health`);
      console.log('='.repeat(60));
      console.log(`✨ 服务正在运行中，等待请求...`);

      if (isTauriSubprocess) {
        initializeTemplateRepository().catch((error) => {
          console.warn('[bootstrap] 后台预热模板仓库失败:', error);
        });
      }
    });
    httpServer.on('connection', (socket) => {
      activeSockets.add(socket);
      socket.on('close', () => activeSockets.delete(socket));
    });
    httpServer.on('error', (error) => {
      if (error?.code === 'EADDRINUSE') {
        console.error(`[bootstrap] ❌ 端口 ${PORT} 已被占用，请关闭旧的雨燕 Node 服务后重试`);
      } else {
        console.error('[bootstrap] ❌ 服务监听失败:', error);
      }
      process.exit(1);
    });
  } catch (error) {
    console.error('[bootstrap] ❌ 服务启动失败:', error);
    process.exit(1);
  }
}

// 执行启动
bootstrap();
