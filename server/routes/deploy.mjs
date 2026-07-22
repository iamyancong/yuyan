/**
 * 独立服务器部署路由
 * @description 定义服务器配置、部署目标、发布记录和 Nginx 配置文件 API
 */

import express from 'express';
import {
  appendArtifactChunk,
  cancelCentralOperation,
  createArtifactJob,
  finalizeArtifactJob,
  getCentralOperation,
  listCentralOperations,
} from '../services/artifact-job-service.mjs';
import {
  handleCreateServer,
  handleCreateTarget,
  handleCreateNginxInstance,
  handleDeleteNginxInstance,
  handleDeleteServer,
  handleDeleteTarget,
  handleDeployTarget,
  handleDownloadNginxInstanceArchive,
  handleSaveNginxInstanceArchive,
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
  handleListTargetRuntimeSnapshots,
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
  handleListJdks,
  handleCreateJdk,
  handleUpdateJdk,
  handleDeleteJdk,
  handleCheckAppUpdate,
  handleCheckTauriAppUpdate,
  handleGetAppUpdateCacheStatus,
  handleDownloadAppUpdateAsset,
  handleTestJdk,
  handleScanLocalJdks,
  handleListServerJavaRuntimes,
  handleCreateServerJavaRuntime,
  handleScanServerJavaRuntimes,
  handleTestServerJavaRuntime,
  handleDeleteServerJavaRuntime,
  handleInspectBackendTarget,
  handleGetBackendServiceStatus,
  handleRunBackendServiceAction,
  handleReadBackendServiceLogs,
  handleGenerateTargetOpenApi,
  handleGetLatestTargetOpenApi,
  handleReadOpenApiArtifact,
  handleDownloadOpenApiArtifact,
  handleListDeployEnvironments,
  handleCreateDeployEnvironment,
  handleUpdateDeployEnvironment,
  handleDeleteDeployEnvironment,
} from '../controllers/deploy-controller.mjs';

const router = express.Router();

/** 发送产物 v2 稳定错误。 */
function sendArtifactError(res, error) {
  const issue = error?.issues?.[0];
  res.status(Number(error?.status || (issue ? 400 : 500))).json({
    success: false,
    error: {
      code: String(error?.code || (issue ? 'invalid_request' : 'artifact_job_error')),
      message: String(issue?.message || error?.message || '产物任务失败'),
      retryable: false,
      ...(Number.isSafeInteger(error?.expectedOffset) ? { expectedOffset: error.expectedOffset } : {}),
    },
  });
}

router.post('/artifact-jobs', async (req, res) => {
  try { res.json({ success: true, data: await createArtifactJob(req.body) }); } catch (error) { sendArtifactError(res, error); }
});
router.put('/artifact-jobs/:id/chunks', express.raw({ type: 'application/octet-stream', limit: '8mb' }), async (req, res) => {
  try { res.json({ success: true, data: await appendArtifactChunk(req.params.id, req.headers['content-range'], req.body) }); } catch (error) { sendArtifactError(res, error); }
});
router.post('/artifact-jobs/:id/finalize', async (req, res) => {
  try { res.json({ success: true, data: await finalizeArtifactJob(req.params.id) }); } catch (error) { sendArtifactError(res, error); }
});
router.get('/operations', async (req, res) => {
  try { res.json({ success: true, data: await listCentralOperations(req.query) }); } catch (error) { sendArtifactError(res, error); }
});
router.get('/operations/:id', async (req, res) => {
  try { res.json({ success: true, data: await getCentralOperation(req.params.id) }); } catch (error) { sendArtifactError(res, error); }
});
router.post('/operations/:id/cancel', async (req, res) => {
  try { res.json({ success: true, data: await cancelCentralOperation(req.params.id) }); } catch (error) { sendArtifactError(res, error); }
});

router.get('/jdks', handleListJdks);
router.post('/jdks', handleCreateJdk);
router.post('/jdks/scan', handleScanLocalJdks);
router.put('/jdks/:id', handleUpdateJdk);
router.delete('/jdks/:id', handleDeleteJdk);
router.post('/jdks/:id/test', handleTestJdk);

router.get('/servers', handleListServers);
router.post('/servers', handleCreateServer);
router.put('/servers/:id', handleUpdateServer);
router.delete('/servers/:id', handleDeleteServer);
router.post('/servers/:id/test', handleTestServer);
router.get('/servers/:id/java-runtimes', handleListServerJavaRuntimes);
router.post('/servers/:id/java-runtimes', handleCreateServerJavaRuntime);
router.post('/servers/:id/java-runtimes/scan', handleScanServerJavaRuntimes);
router.post('/java-runtimes/:id/test', handleTestServerJavaRuntime);
router.delete('/java-runtimes/:id', handleDeleteServerJavaRuntime);
router.get('/environments', handleListDeployEnvironments);
router.post('/environments', handleCreateDeployEnvironment);
router.put('/environments/:id', handleUpdateDeployEnvironment);
router.delete('/environments/:id', handleDeleteDeployEnvironment);
router.get('/servers/:id/nginx-instances', handleListNginxInstances);
router.post('/servers/:id/nginx-instances', handleCreateNginxInstance);
router.get('/servers/:id/nginx-runtime', handleGetNginxRuntime);
router.post('/servers/:id/nginx-runtime/init', handleInitNginxRuntime);
router.get('/servers/:id/nginx-runtime/next-port', handleGetNextNginxRuntimePort);
router.post('/servers/:id/nginx-runtime/:action', handleRunNginxRuntimeAction);
router.put('/nginx-instances/:id', handleUpdateNginxInstance);
router.delete('/nginx-instances/:id', handleDeleteNginxInstance);
router.get('/nginx-instances/:id/archive', handleDownloadNginxInstanceArchive);
router.post('/nginx-instances/:id/archive-save', handleSaveNginxInstanceArchive);
router.get('/nginx-instances/:id/status', handleGetNginxInstanceStatus);
router.post('/nginx-instances/:id/init', handleInitNginxInstance);
router.post('/nginx-instances/:id/actions/:action', handleRunNginxInstanceAction);
router.get('/nginx-instances/:id/next-port', handleGetNextNginxInstancePort);

router.get('/targets', handleListTargets);
router.get('/targets/runtime-snapshots', handleListTargetRuntimeSnapshots);
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
router.post('/targets/:id/inspect', handleInspectBackendTarget);
router.get('/targets/:id/service-status', handleGetBackendServiceStatus);
router.post('/targets/:id/service-actions/:action', handleRunBackendServiceAction);
router.get('/targets/:id/service-logs', handleReadBackendServiceLogs);
router.post('/targets/:id/openapi/generate', handleGenerateTargetOpenApi);
router.get('/targets/:id/openapi/latest', handleGetLatestTargetOpenApi);
router.get('/openapi-artifacts/:id/content', handleReadOpenApiArtifact);
router.get('/openapi-artifacts/:id/download', handleDownloadOpenApiArtifact);

router.get('/records', handleListRecords);
router.get('/records/:id', handleGetRecord);
router.post('/records/:id/rollback', handleRollbackRecord);
router.post('/records/:id/undo-rollback', handleUndoRollbackRecord);

// 原始数据库备份/恢复不再对桌面端开放，避免跨用户整库复制。
router.all('/db/backup', (_req, res) => res.status(410).json({ success: false, error: { code: 'raw_database_sync_removed', message: '原始数据库同步已移除，请刷新当前账号配置' } }));
router.all('/db/restore', (_req, res) => res.status(410).json({ success: false, error: { code: 'raw_database_sync_removed', message: '原始数据库恢复已移除' } }));

// 自动更新检测与原生下载代理接口
router.get('/app-update/check', handleCheckAppUpdate);
router.get('/app-update/tauri/:target/:arch/:currentVersion', handleCheckTauriAppUpdate);
router.get('/app-update/cache-status', handleGetAppUpdateCacheStatus);
router.get('/app-update/download-asset', handleDownloadAppUpdateAsset);

export default router;
