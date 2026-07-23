/** Agent Gateway 私有路由。 */

import express from 'express';
import {
  handleAgentToolCall,
  handleApproveAgentOperation,
  handleCancelAgentOperation,
  handleClearCompletedAgentOperations,
  handleDeleteAgentOperation,
  handleDesktopBackendDeploy,
  handleDesktopOpenApiGenerate,
  handleGetDesktopOpenApiLatest,
  handleGetAgentClients,
  handleGetAgentOperation,
  handleGetAgentSnapshot,
  handleAgentEvents,
  handleListPendingAgentApprovals,
  handleInstallAgentClient,
  handleRejectAgentOperation,
  handleReadDesktopOpenApi,
  handleRevokeAgentGrant,
  handleUninstallAgentClient,
  handleUpdateAgentSettings,
  handleUpdateAgentApprovalPolicy,
  handleUpdateAgentOperationRetentionPolicy,
} from '../controllers/agent-controller.mjs';

const router = express.Router();

router.post('/tools/:toolName', handleAgentToolCall);
router.get('/snapshot', handleGetAgentSnapshot);
router.get('/events', handleAgentEvents);
router.get('/pending-approvals', handleListPendingAgentApprovals);
router.delete('/operations/completed', handleClearCompletedAgentOperations);
router.get('/operations/:id', handleGetAgentOperation);
router.post('/operations/:id/approve', handleApproveAgentOperation);
router.post('/operations/:id/reject', handleRejectAgentOperation);
router.post('/operations/:id/cancel', handleCancelAgentOperation);
router.delete('/operations/:id', handleDeleteAgentOperation);
router.post('/desktop/backend-deploy', handleDesktopBackendDeploy);
router.post('/desktop/openapi/generate', handleDesktopOpenApiGenerate);
router.get('/desktop/openapi/latest', handleGetDesktopOpenApiLatest);
router.get('/desktop/openapi/:id', handleReadDesktopOpenApi);
router.delete('/grants/:id', handleRevokeAgentGrant);
router.post('/settings', handleUpdateAgentSettings);
router.put('/approval-policy', handleUpdateAgentApprovalPolicy);
router.put('/operation-retention-policy', handleUpdateAgentOperationRetentionPolicy);
router.get('/clients', handleGetAgentClients);
router.post('/clients/:client/install', handleInstallAgentClient);
router.post('/clients/:client/uninstall', handleUninstallAgentClient);

export default router;
