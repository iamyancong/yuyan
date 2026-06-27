#!/usr/bin/env node
/**
 * Scaffold 服务入口
 * @description Express 应用初始化、中间件配置、路由注册、服务启动
 */

import express from 'express';
import fs from 'node:fs';
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
} from './config/constants.mjs';
import { pullLatestTemplate, validateTemplate } from './services/template-service.mjs';
import { startCleanupScheduler } from './utils/cleanup-scheduler.mjs';
import scaffoldRoutes from './routes/scaffold.mjs';
import deployRoutes from './routes/deploy.mjs';
import healthRoutes from './routes/health.mjs';
import { getDeployDb } from './services/deploy-store.mjs';

// 创建 Express 应用
const app = express();

// 中间件配置
app.use(cors());
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
app.use('/scaffold-api', scaffoldRoutes);

// 独立服务器部署 API 路由
app.use('/deploy-api', deployRoutes);

// SPA history 回退（Express 5 兼容），排除接口与健康检查
try {
  app.use(
    history({
      htmlAcceptHeaders: ['text/html', 'application/xhtml+xml'],
      disableDotRule: true,
      rewrites: [{ from: /^\/(scaffold-api|deploy-api|app-updates|health)(?:\/|$)/, to: (ctx) => ctx.parsedUrl.pathname }],
    })
  );
} catch {}

/** 不参与静态资源压缩的路由前缀，避免接口流式响应被缓冲 */
const noStaticCompressionRoutePattern = /^\/(?:scaffold-api|deploy-api|app-updates|health)(?:\/|$)/;

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

/**
 * 服务启动入口
 */
async function bootstrap() {
  try {
    console.log('='.repeat(60));
    console.log(`🚀 Scaffold 服务启动中...`);
    console.log(`📂 模板路径: ${TEMPLATE_REPO_PATH}`);
    console.log(`🔗 模板仓库: ${TEMPLATE_REPO_URL}`);
    console.log(`🌿 模板分支: ${TEMPLATE_BRANCH}`);
    console.log('='.repeat(60));

    // 启动时拉取最新模板
    console.log('[bootstrap] 正在初始化模板仓库...');
    const success = await pullLatestTemplate();

    if (!success) {
      console.warn('[bootstrap] ⚠️ 模板初始化失败，服务将继续启动，但创建项目可能会失败');
      console.warn('[bootstrap] 请检查：');
      console.warn('[bootstrap]   1. GITLAB_TOKEN 环境变量是否正确设置');
      console.warn('[bootstrap]   2. 模板仓库 URL 是否可访问');
      console.warn('[bootstrap]   3. 网络连接是否正常');
    } else {
      // 验证模板脚本是否存在
      const isValid = await validateTemplate();
      if (isValid) {
        console.log('[bootstrap] ✅ 模板初始化成功，脚本已就绪');
      } else {
        console.error('[bootstrap] ❌ 模板目录存在但脚本文件缺失');
        console.error('[bootstrap] 请检查模板仓库结构是否正确');
      }
    }

    // 启动定时清理任务
    startCleanupScheduler();

    // 初始化独立服务器部署数据库
    await getDeployDb();
    console.log(`[bootstrap] ✅ 独立服务器部署数据库已就绪: ${DEPLOY_DB_PATH}`);

    // 启动服务
    app.listen(PORT, () => {
      console.log('='.repeat(60));
      console.log(`🚀 Scaffold 服务启动成功!`);
      console.log(`📍 服务地址: http://localhost:${PORT}`);
      console.log(`💚 健康检查: http://localhost:${PORT}/health`);
      console.log('='.repeat(60));
      console.log(`✨ 服务正在运行中，等待请求...`);
    });
  } catch (error) {
    console.error('[bootstrap] ❌ 服务启动失败:', error);
    process.exit(1);
  }
}

// 执行启动
bootstrap();
