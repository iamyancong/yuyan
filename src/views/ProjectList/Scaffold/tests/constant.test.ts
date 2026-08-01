import assert from 'node:assert/strict';
import test from 'node:test';
import { createCredentialFingerprint, getNamespaceErrorFeedback } from '../constant.ts';

test('Namespace 权限类错误会提示重新选择并清空失效值', () => {
  const forbidden = getNamespaceErrorFeedback({ response: { status: 403 } });
  const notFound = getNamespaceErrorFeedback({ response: { status: 404 } });

  assert.equal(forbidden.shouldClearSelection, true);
  assert.match(forbidden.message, /无权访问/);
  assert.equal(notFound.shouldClearSelection, true);
  assert.match(notFound.message, /不存在/);
});

test('Namespace 临时请求错误会保留用户选择以便重试', () => {
  const unauthorized = getNamespaceErrorFeedback({ response: { status: 401 } });
  const rateLimited = getNamespaceErrorFeedback({ response: { status: 429 } });
  const unavailable = getNamespaceErrorFeedback({ response: { status: 503 } });
  const networkError = getNamespaceErrorFeedback({ code: 'ERR_NETWORK' });

  assert.equal(unauthorized.shouldClearSelection, false);
  assert.equal(rateLimited.shouldClearSelection, false);
  assert.equal(unavailable.shouldClearSelection, false);
  assert.equal(networkError.shouldClearSelection, false);
});

test('Token 缓存指纹稳定且不包含明文', () => {
  const token = 'glpat-sensitive-token-value';
  const fingerprint = createCredentialFingerprint(token);

  assert.equal(fingerprint, createCredentialFingerprint(token));
  assert.notEqual(fingerprint, createCredentialFingerprint(`${token}-changed`));
  assert.equal(fingerprint.includes(token), false);
});
