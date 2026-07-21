/** 雨燕中央 v2 身份与设备路由。 */

import express from 'express';
import {
  authorizeCentralV2,
  exchangeGitlabIdentity,
  getAccountApprovalPolicy,
  getCentralAuditSnapshot,
  listUserDevices,
  logoutCentralSession,
  refreshDeviceSession,
  replaceAccountApprovalPolicy,
  revokeUserDevice,
} from '../services/central-identity-service.mjs';
import { getRequestContext } from '../services/request-context.mjs';

const router = express.Router();

/** 将领域异常转换为稳定错误结构。 */
function sendError(res, error) {
  const validationIssue = error?.issues?.[0];
  const status = Number(error?.status || (validationIssue ? 400 : 500));
  res.status(status).json({
    success: false,
    error: {
      code: String(error?.code || (validationIssue ? 'invalid_request' : 'identity_error')),
      message: String(validationIssue?.message || error?.message || '身份服务异常'),
      retryable: status >= 500,
    },
  });
}

router.post('/auth/gitlab/exchange', async (req, res) => {
  try {
    res.json({ success: true, data: await exchangeGitlabIdentity(req.body) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/auth/refresh', async (req, res) => {
  try {
    res.json({ success: true, data: await refreshDeviceSession(req.body) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post('/auth/logout', authorizeCentralV2, async (req, res) => {
  try {
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    res.json({ success: true, data: await logoutCentralSession(bearer) });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/me', authorizeCentralV2, (req, res) => {
  const context = getRequestContext();
  res.json({
    success: true,
    data: {
      accountId: context.accountId,
      userId: context.userId,
      deviceId: context.deviceId,
    },
  });
});

router.get('/me/devices', authorizeCentralV2, async (_req, res) => {
  try {
    const context = getRequestContext();
    res.json({ success: true, data: await listUserDevices(context.userId) });
  } catch (error) {
    sendError(res, error);
  }
});

router.delete('/me/devices/:deviceId', authorizeCentralV2, async (req, res) => {
  try {
    const context = getRequestContext();
    res.json({ success: true, data: await revokeUserDevice(context.userId, req.params.deviceId) });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/me/audit', authorizeCentralV2, async (req, res) => {
  try {
    const context = getRequestContext();
    res.json({ success: true, data: await getCentralAuditSnapshot(context, req.query) });
  } catch (error) {
    sendError(res, error);
  }
});

router.get('/me/approval-policy', authorizeCentralV2, async (_req, res) => {
  try {
    const context = getRequestContext();
    res.json({ success: true, data: await getAccountApprovalPolicy(context) });
  } catch (error) {
    sendError(res, error);
  }
});

router.put('/me/approval-policy', authorizeCentralV2, async (req, res) => {
  try {
    const context = getRequestContext();
    res.json({ success: true, data: await replaceAccountApprovalPolicy(context, req.body) });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
