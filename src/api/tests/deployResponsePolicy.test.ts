import assert from 'node:assert/strict';
import test from 'node:test';
import { extractApiErrorInfo, normalizeDeployHttpError } from '../deployResponsePolicy.ts';
import { isRecoverableReadError } from '../../utils/centralReadRecovery.ts';

test('extractApiErrorInfo：提取顶层 code 与 message', () => {
  assert.deepEqual(
    extractApiErrorInfo({
      success: false,
      error: '站点冲突',
      code: 'NGINX_SITE_CONFLICT',
    }),
    { code: 'NGINX_SITE_CONFLICT', message: '站点冲突' }
  );
});

test('extractApiErrorInfo：嵌套 error 格式（code、message、retryable）', () => {
  assert.deepEqual(
    extractApiErrorInfo({
      success: false,
      error: { code: 'session_invalid', message: '登录凭据已过期', retryable: true },
    }),
    { code: 'session_invalid', message: '登录凭据已过期', retryable: true }
  );

  // retryable 非布尔时不应给出
  assert.deepEqual(
    extractApiErrorInfo({
      success: false,
      error: { code: 'some_code', message: '提示', retryable: 'true' },
    }),
    { code: 'some_code', message: '提示' }
  );
});

test('extractApiErrorInfo：两者都有 code 时顶层优先', () => {
  const info = extractApiErrorInfo({
    code: 'TOP_LEVEL_CODE',
    error: { code: 'NESTED_CODE', message: '嵌套错误' },
  });
  assert.equal(info.code, 'TOP_LEVEL_CODE');
  assert.equal(info.message, '嵌套错误');
});

test('extractApiErrorInfo：message 优先级（body.error 字符串 > body.error.message > body.message）', () => {
  assert.equal(
    extractApiErrorInfo({ error: '优先错误', message: '次要错误' }).message,
    '优先错误'
  );
  assert.equal(
    extractApiErrorInfo({ error: { message: '对象错误' }, message: '顶层错误' }).message,
    '对象错误'
  );
  assert.equal(
    extractApiErrorInfo({ message: '仅顶层消息' }).message,
    '仅顶层消息'
  );
});

test('extractApiErrorInfo：body 为 null、字符串或 HTML 时返回空对象', () => {
  assert.deepEqual(extractApiErrorInfo(null), {});
  assert.deepEqual(extractApiErrorInfo(undefined), {});
  assert.deepEqual(extractApiErrorInfo('<html>502 Bad Gateway</html>'), {});
  assert.deepEqual(extractApiErrorInfo(12345), {});
});

test('normalizeDeployHttpError：顶层 code 格式（如 409 站点冲突）', () => {
  const axiosError: any = new Error('Request failed with status code 409');
  axiosError.code = 'ERR_BAD_REQUEST';
  axiosError.response = {
    status: 409,
    data: { success: false, error: '站点冲突', code: 'NGINX_SITE_CONFLICT' },
  };
  const result = normalizeDeployHttpError(axiosError);
  assert.equal(result.code, 'NGINX_SITE_CONFLICT');
  assert.equal(result.apiCode, 'NGINX_SITE_CONFLICT');
  assert.equal(result.axiosCode, 'ERR_BAD_REQUEST');
  assert.equal(result.userMessage, '站点冲突');
  assert.equal(result.response.status, 409);
  assert.equal(result.message, 'Request failed with status code 409');
});

test('normalizeDeployHttpError：嵌套格式（401 session_invalid、retryable:true）', () => {
  const axiosError: any = new Error('Request failed with status code 401');
  axiosError.code = 'ERR_BAD_REQUEST';
  axiosError.response = {
    status: 401,
    data: {
      success: false,
      error: { code: 'session_invalid', message: '登录凭据已过期', retryable: true },
    },
  };
  const result = normalizeDeployHttpError(axiosError);
  assert.equal(result.code, 'session_invalid');
  assert.equal(result.apiCode, 'session_invalid');
  assert.equal(result.axiosCode, 'ERR_BAD_REQUEST');
  assert.equal(result.retryable, true);
  assert.equal(result.userMessage, '登录凭据已过期');
});

test('normalizeDeployHttpError：无业务码时 code 保持 axios 原码且不加 apiCode', () => {
  const axiosError: any = new Error('Request failed with status code 500');
  axiosError.code = 'ERR_BAD_RESPONSE';
  axiosError.response = {
    status: 500,
    data: { success: false, message: '服务器内部错误' },
  };
  const result = normalizeDeployHttpError(axiosError);
  assert.equal(result.code, 'ERR_BAD_RESPONSE');
  assert.equal(result.apiCode, undefined);
  assert.equal(result.axiosCode, undefined);
  assert.equal(result.userMessage, '服务器内部错误');
});

test('normalizeDeployHttpError：网络错误无 response 时不修改任何字段', () => {
  const networkError: any = new Error('Network Error');
  networkError.code = 'ERR_NETWORK';
  const result = normalizeDeployHttpError(networkError);
  assert.equal(result.code, 'ERR_NETWORK');
  assert.equal(result.apiCode, undefined);
  assert.equal(result.axiosCode, undefined);
  assert.equal(result.userMessage, undefined);
});

test('normalizeDeployHttpError：取消请求（ERR_CANCELED / CanceledError / AbortError）不变且无 userMessage', () => {
  const cancel1: any = new Error('canceled');
  cancel1.code = 'ERR_CANCELED';
  normalizeDeployHttpError(cancel1);
  assert.equal(cancel1.code, 'ERR_CANCELED');
  assert.equal(cancel1.userMessage, undefined);

  const cancel2: any = new Error('Request aborted');
  cancel2.name = 'CanceledError';
  normalizeDeployHttpError(cancel2);
  assert.equal(cancel2.name, 'CanceledError');
  assert.equal(cancel2.userMessage, undefined);

  const cancel3: any = new Error('The user aborted a request');
  cancel3.name = 'AbortError';
  normalizeDeployHttpError(cancel3);
  assert.equal(cancel3.name, 'AbortError');
  assert.equal(cancel3.userMessage, undefined);
});

test('normalizeDeployHttpError：已有 userMessage 不覆盖', () => {
  const axiosError: any = new Error('fail');
  axiosError.userMessage = '上游自定义错误文案';
  axiosError.response = {
    status: 400,
    data: { error: '服务端文案', code: 'PARAM_ERROR' },
  };
  const result = normalizeDeployHttpError(axiosError);
  assert.equal(result.userMessage, '上游自定义错误文案');
  assert.equal(result.code, 'PARAM_ERROR');
});

test('normalizeDeployHttpError：body 为 HTML 字符串时不产生异常也不误填', () => {
  const htmlError: any = new Error('Bad Gateway');
  htmlError.code = 'ERR_BAD_RESPONSE';
  htmlError.response = {
    status: 502,
    data: '<html>502 Bad Gateway</html>',
  };
  const result = normalizeDeployHttpError(htmlError);
  assert.equal(result.code, 'ERR_BAD_RESPONSE');
  assert.equal(result.apiCode, undefined);
  assert.equal(result.userMessage, undefined);
});

test('normalizeDeployHttpError 与 isRecoverableReadError 集成：503/409/ERR_NETWORK/取消判定', () => {
  // 1. 503 带业务码仍为 true
  const error503: any = new Error('Service Unavailable');
  error503.code = 'ERR_BAD_RESPONSE';
  error503.response = {
    status: 503,
    data: { success: false, code: 'SERVICE_MAINTENANCE', message: '系统维护中' },
  };
  normalizeDeployHttpError(error503);
  assert.equal(error503.code, 'SERVICE_MAINTENANCE');
  assert.equal(isRecoverableReadError(error503), true);

  // 2. 409 为 false
  const error409: any = new Error('Conflict');
  error409.code = 'ERR_BAD_REQUEST';
  error409.response = {
    status: 409,
    data: { success: false, code: 'NGINX_SITE_CONFLICT', error: '站点冲突' },
  };
  normalizeDeployHttpError(error409);
  assert.equal(isRecoverableReadError(error409), false);

  // 3. ERR_NETWORK 仍为 true
  const netError: any = new Error('Network Error');
  netError.code = 'ERR_NETWORK';
  normalizeDeployHttpError(netError);
  assert.equal(isRecoverableReadError(netError), true);

  // 4. 取消为 false
  const cancelError: any = new Error('canceled');
  cancelError.code = 'ERR_CANCELED';
  normalizeDeployHttpError(cancelError);
  assert.equal(isRecoverableReadError(cancelError), false);
});
