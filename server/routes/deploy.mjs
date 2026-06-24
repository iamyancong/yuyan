/**
 * 独立服务器部署路由
 * @description 定义服务器配置、部署目标、发布记录和 Nginx 配置文件 API
 */

import express from 'express';
import {
  handleCreateServer,
  handleCreateTarget,
  handleCreateNginxInstance,
  handleDeleteNginxInstance,
  handleDeleteServer,
  handleDeleteTarget,
  handleDeployTarget,
  handleDownloadNginxInstanceArchive,
  handleGetNextNginxInstancePort,
  handleGetTargetDeployProgress,
  handleGetRecord,
  handleGetNextNginxRuntimePort,
  handleGetNginxInstanceStatus,
  handleGetNginxRuntime,
  handleInitNginxRuntime,
  handleInitNginxInstance,
  handleListNginxInstances,
  handleListRecords,
  handleListServers,
  handleListTargets,
  handleReadNginxConfig,
  handleRollbackRecord,
  handleRunNginxInstanceAction,
  handleRunNginxRuntimeAction,
  handleSaveNginxConfig,
  handleStopDeployTarget,
  handleSyncTargetNginxSite,
  handleTestNginx,
  handleTestServer,
  handleUndoRollbackRecord,
  handleUpdateServer,
  handleUpdateTarget,
  handleUpdateNginxInstance,
  handleBackupDb,
  handleRestoreDb,
} from '../controllers/deploy-controller.mjs';

const router = express.Router();

router.get('/servers', handleListServers);
router.post('/servers', handleCreateServer);
router.put('/servers/:id', handleUpdateServer);
router.delete('/servers/:id', handleDeleteServer);
router.post('/servers/:id/test', handleTestServer);
router.get('/servers/:id/nginx-instances', handleListNginxInstances);
router.post('/servers/:id/nginx-instances', handleCreateNginxInstance);
router.get('/servers/:id/nginx-runtime', handleGetNginxRuntime);
router.post('/servers/:id/nginx-runtime/init', handleInitNginxRuntime);
router.get('/servers/:id/nginx-runtime/next-port', handleGetNextNginxRuntimePort);
router.post('/servers/:id/nginx-runtime/:action', handleRunNginxRuntimeAction);
router.put('/nginx-instances/:id', handleUpdateNginxInstance);
router.delete('/nginx-instances/:id', handleDeleteNginxInstance);
router.get('/nginx-instances/:id/archive', handleDownloadNginxInstanceArchive);
router.get('/nginx-instances/:id/status', handleGetNginxInstanceStatus);
router.post('/nginx-instances/:id/init', handleInitNginxInstance);
router.post('/nginx-instances/:id/actions/:action', handleRunNginxInstanceAction);
router.get('/nginx-instances/:id/next-port', handleGetNextNginxInstancePort);

router.get('/targets', handleListTargets);
router.post('/targets', handleCreateTarget);
router.put('/targets/:id', handleUpdateTarget);
router.delete('/targets/:id', handleDeleteTarget);
router.post('/targets/:id/nginx-site/sync', handleSyncTargetNginxSite);
router.get('/targets/:id/nginx-conf', handleReadNginxConfig);
router.put('/targets/:id/nginx-conf', handleSaveNginxConfig);
router.post('/targets/:id/nginx-test', handleTestNginx);
router.get('/targets/:id/deploy-progress', handleGetTargetDeployProgress);
router.post('/targets/:id/deploy', handleDeployTarget);
router.post('/targets/:id/deploy/stop', handleStopDeployTarget);

router.get('/records', handleListRecords);
router.get('/records/:id', handleGetRecord);
router.post('/records/:id/rollback', handleRollbackRecord);
router.post('/records/:id/undo-rollback', handleUndoRollbackRecord);

// 数据库备份与恢复同步接口
router.get('/db/backup', handleBackupDb);
router.post('/db/restore', express.raw({ type: 'application/octet-stream', limit: '50mb' }), handleRestoreDb);

export default router;

