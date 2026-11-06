import { watch } from 'vue';

/**
 * 等待条件成立（watch 驱动），带超时兜底。
 * @description 替代「忙等轮询」与「无限等待」两种极端：
 * 条件已成立时同步 resolve(true)；条件翻转时立即 resolve(true)；
 * 超过 timeoutMs 仍未成立时 resolve(false) 并停止监听，避免上游挂起导致调用方无限等待。
 * @param isDone 条件判断函数（作为 watch 的 getter 源，需访问响应式依赖）
 * @param timeoutMs 超时毫秒数；传入 Infinity 表示无限等待
 * @returns 条件是否成立（false 表示超时）
 */
export const waitForCondition = (isDone: () => boolean, timeoutMs: number): Promise<boolean> => {
  if (isDone()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    // setTimeout(fn, Infinity) 在 Node 中会被强制改为 1ms 并告警，仅在有限值时创建
    const timer = Number.isFinite(timeoutMs) ? setTimeout(() => finish(false), timeoutMs) : null;
    const stop = watch(isDone, (done) => {
      if (done) finish(true);
    });
    function finish(met: boolean) {
      if (settled) return;
      settled = true;
      stop();
      if (timer !== null) clearTimeout(timer);
      resolve(met);
    }
  });
};
