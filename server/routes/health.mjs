/**
 * 健康检查路由
 * @description 提供服务健康状态检查端点
 */

import express from 'express';

const router = express.Router();

/**
 * GET /health
 * 健康检查端点
 */
router.get('/', (req, res) => {
  res.status(200).send('ok');
});

export default router;
