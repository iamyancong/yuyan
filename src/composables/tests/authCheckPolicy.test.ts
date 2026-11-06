import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyGitlabUserError,
  decideCheckAuthRemoteAction,
  shouldAbortAuthGeneration,
} from '../authCheckPolicy.ts';

/**
 * 对应 checkAuth 路径契约说明：
 *
 * 1. 401 响应（unauthorized 路径）：
 *    - 当 GitLab /user 返回 401 时，表示凭据已失效或被撤销，classifyGitlabUserError 判定为 'unauthorized'；
 *    - decideCheckAuthRemoteAction 决策为 'logout'，触发 logout(true) 静默清理失效账号，
 *      绝对不执行 applySecureState，防止将失效 PAT 重新写回已登录导致页面假登录；
 *    - logout 会自增 authGeneration，使得该代次在后续校验中失效。
 *
 * 2. 网络错误/服务端故障（unavailable 离线恢复路径）：
 *    - 当遭遇网络断开（无 response）、超时（ECONNABORTED）、5xx 内部错误或 403 权限受限时，判定为 'unavailable'；
 *    - decideCheckAuthRemoteAction 决策为 'apply-cached'；
 *    - checkAuth 省略远程用户参数，调用 applySecureState(refreshed, null)，利用本地缓存的 username/displayName 完成离线恢复。
 *
 * 3. 成功获取用户信息（ok 路径）：
 *    - GitLab /user 成功返回用户数据时，判定为 'ok'；
 *    - decideCheckAuthRemoteAction 决策为 'apply-remote'；
 *    - 调用 applySecureState(refreshed, remote.user) 写入最新远程用户信息。
 *
 * 4. 并发与重叠登出保护（代次门闩路径）：
 *    - 每次 checkAuth 开头记录 const gen = ++authGeneration；
 *    - 任何在途异步操作（loadActiveSecureAccount / refreshSecureSessionIfNeeded / fetchRemoteUser）返回后，
 *      均通过 shouldAbortAuthGeneration(gen, authGeneration) 校验代次；
 *    - 若在 checkAuth 期间用户点击了 logout（++authGeneration）或触发了新的 checkAuth，
 *      旧代次的响应被严格丢弃，防止将上一账号数据错误 applySecureState。
 *
 * 5. loading 状态复位契约（finally 兜底）：
 *    - checkAuth 开头置 authState.value.loading = true；
 *    - 无论早退（未找到存储账号、代次过期）、抛错还是正常完成，均在 finally 块中判断：
 *      if (gen === authGeneration) { authState.value.loading = false; }
 *    - 若期间发生 logout，因为 generation 已自增，finally 不会覆盖 logout 设置的 loading=false；
 *      若正常或异常结束且仍属当前代次，loading 确保复位为 false，防止卡死页面和 waitForAuthReady。
 */

test('classifyGitlabUserError：仅 401 判定为 unauthorized', () => {
  assert.equal(classifyGitlabUserError({ response: { status: 401 } }), 'unauthorized');
});

test('classifyGitlabUserError：500 内部服务错误判定为 unavailable', () => {
  assert.equal(classifyGitlabUserError({ response: { status: 500 } }), 'unavailable');
});

test('classifyGitlabUserError：403 禁止访问判定为 unavailable', () => {
  assert.equal(classifyGitlabUserError({ response: { status: 403 } }), 'unavailable');
});

test('classifyGitlabUserError：无 response 的网络错误（如断网）判定为 unavailable', () => {
  assert.equal(classifyGitlabUserError(new Error('network')), 'unavailable');
});

test('classifyGitlabUserError：请求超时（ECONNABORTED）判定为 unavailable', () => {
  assert.equal(classifyGitlabUserError({ code: 'ECONNABORTED' }), 'unavailable');
});

test('decideCheckAuthRemoteAction：根据远程结果正确决策下一步动作', () => {
  // 401 -> 登出，不恢复
  assert.deepEqual(decideCheckAuthRemoteAction('unauthorized'), { action: 'logout' });
  // 网络故障/不可用 -> 离线恢复，使用缓存凭据
  assert.deepEqual(decideCheckAuthRemoteAction('unavailable'), { action: 'apply-cached' });
  // 正常 -> 使用远程用户恢复
  assert.deepEqual(decideCheckAuthRemoteAction('ok'), { action: 'apply-remote' });
});

test('shouldAbortAuthGeneration：代次一致时不中止，代次递增（如 logout 或新请求发出）后立即中止', () => {
  let authGeneration = 0;

  // 1. 发起第 1 轮 checkAuth
  const gen1 = ++authGeneration;
  assert.equal(shouldAbortAuthGeneration(gen1, authGeneration), false);

  // 2. 模拟期间用户点击登出，触发 ++authGeneration
  ++authGeneration;
  // gen1 应当中止，避免覆盖登出状态
  assert.equal(shouldAbortAuthGeneration(gen1, authGeneration), true);

  // 3. 再次发起第 2 轮 checkAuth
  const gen2 = ++authGeneration;
  assert.equal(shouldAbortAuthGeneration(gen2, authGeneration), false);

  // 4. 模拟并发快速发起了第 3 轮 checkAuth
  const gen3 = ++authGeneration;
  // gen2 已被废弃
  assert.equal(shouldAbortAuthGeneration(gen2, authGeneration), true);
  // gen3 有效
  assert.equal(shouldAbortAuthGeneration(gen3, authGeneration), false);
});
