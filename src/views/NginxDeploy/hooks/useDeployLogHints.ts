import { ref, watch } from 'vue';

/** 白话提示开关本地存储键 */
const DEPLOY_LOG_HINTS_STORAGE_KEY = 'yuyan:deploy-log-hints';

/**
 * 读取本地存储的白话提示开关（默认开启）。
 * @returns 是否展示白话提示
 */
function readStoredHintsEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(DEPLOY_LOG_HINTS_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

/** 全局共享：发布进度抽屉与发布记录日志抽屉保持同一开关状态 */
const showLogHints = ref(readStoredHintsEnabled());

watch(showLogHints, (enabled) => {
  try {
    globalThis.localStorage?.setItem(DEPLOY_LOG_HINTS_STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // 隐私模式等不可写场景下仅保留内存态
  }
});

/**
 * 发布日志白话提示开关（跨组件共享并持久化到本地）。
 * @returns showLogHints 是否展示白话提示
 */
export function useDeployLogHints() {
  return { showLogHints };
}
