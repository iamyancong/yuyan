/** 中央长任务运行控制器注册表，仅保存当前进程可取消句柄。 */

const activeControllers = new Map();

/** 注册中央运行任务的用户与设备归属。 */
export function registerCentralOperationController(operationId, metadata, controller) {
  activeControllers.set(operationId, { ...metadata, controller });
}

/** 移除已结束的中央任务控制器。 */
export function unregisterCentralOperationController(operationId) {
  activeControllers.delete(operationId);
}

/** 安全停止单个中央运行任务。 */
export function abortCentralOperation(operationId) {
  const item = activeControllers.get(operationId);
  if (!item || item.controller.signal.aborted) return false;
  item.controller.abort();
  return true;
}

/** 安全停止指定用户设备发起的中央运行任务。 */
export function abortCentralOperationsForDevice(userId, deviceId) {
  let aborted = 0;
  for (const item of activeControllers.values()) {
    if (item.userId === userId && item.deviceId === deviceId && !item.controller.signal.aborted) {
      item.controller.abort();
      aborted += 1;
    }
  }
  return aborted;
}

/** 安全停止用户在指定账号隔离空间发起的全部中央运行任务。 */
export function abortCentralOperationsForActor(userId, teamId) {
  let aborted = 0;
  for (const item of activeControllers.values()) {
    if (item.userId === userId && item.teamId === teamId && !item.controller.signal.aborted) {
      item.controller.abort();
      aborted += 1;
    }
  }
  return aborted;
}
