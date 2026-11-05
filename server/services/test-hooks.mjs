/**
 * 内部测试钩子模块（严格受环境门禁保护）。
 * 仅允许在单元测试环境（process.env.NODE_TEST_CONTEXT 或 process.env.YUYAN_ALLOW_TEST_HOOKS）下启用。
 * 生产环境调用 __setTestHooks 将直接抛出致命错误，getTestHooks 始终返回 null。
 */

let activeTestHooks = null;

/**
 * 判断当前是否处于受信任的单元测试运行环境。
 * @returns {boolean}
 */
export function isTestHookAllowed() {
  return Boolean(process.env.NODE_TEST_CONTEXT || process.env.YUYAN_ALLOW_TEST_HOOKS);
}

/**
 * 设置模块级测试钩子。
 * @param {Object|null} hooks - 测试钩子对象
 */
export function __setTestHooks(hooks) {
  if (!isTestHookAllowed()) {
    throw new Error('Test hooks are strictly prohibited outside test execution environments');
  }
  activeTestHooks = hooks ? { ...hooks } : null;
}

/**
 * 重置/清空模块级测试钩子。
 */
export function __resetTestHooks() {
  activeTestHooks = null;
}

/**
 * 获取当前已注册的测试钩子。
 * 若不在测试环境中，始终返回 null，杜绝生产泄露。
 * @returns {Object|null}
 */
export function getTestHooks() {
  if (!isTestHookAllowed()) {
    return null;
  }
  return activeTestHooks;
}
