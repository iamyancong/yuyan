/**
 * 脚手架相关路由
 * @description 定义所有脚手架 API 端点
 */

import express from 'express';
import { handleCreateScaffold, handleBackfillTopics } from '../controllers/scaffold-controller.mjs';
import { handleDownload } from '../controllers/download-controller.mjs';

const router = express.Router();

/**
 * POST /scaffold-api/create
 * 创建新的脚手架项目
 */
router.post('/create', handleCreateScaffold);

/**
 * GET /scaffold-api/download/:appName/:timestamp
 * 下载已生成的项目（压缩包）
 */
router.get('/download/:appName/:timestamp', handleDownload);

/**
 * POST /scaffold-api/ops/backfill-topics
 * 批量为已有项目添加 yuyan-ops 标签
 */
router.post('/ops/backfill-topics', handleBackfillTopics);

export default router;
