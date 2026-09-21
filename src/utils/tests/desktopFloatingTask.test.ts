import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopFloatingTask, formatTaskBytes } from '../desktopFloatingTask.ts';

test('formatTaskBytes: 正确格式化字节大小', () => {
  assert.equal(formatTaskBytes(500), '500 B');
  assert.equal(formatTaskBytes(1024), '1.0 KB');
  assert.equal(formatTaskBytes(1536), '1.5 KB');
  assert.equal(formatTaskBytes(1048576), '1.00 MB');
  assert.equal(formatTaskBytes(22511616), '21.47 MB');
});

test('desktopFloatingTask: 非 Tauri 环境下安全执行不抛出异常', async () => {
  let actionTriggered = false;

  await desktopFloatingTask.startProgress({
    taskId: 'test-task-1',
    title: '正在导出配置',
    projectName: 'Nginx 服务',
    stage: '正在打包',
    loadedBytes: 1024,
    totalBytes: 2048,
    progressPercentage: 50,
    onAction: (actionId) => {
      if (actionId === 'cancel') {
        actionTriggered = true;
      }
    },
  });

  await desktopFloatingTask.updateProgress({
    loadedBytes: 2048,
    totalBytes: 2048,
    progressPercentage: 100,
    stage: '传输完成',
  });

  await desktopFloatingTask.finish({
    taskId: 'test-task-1',
    status: 'success',
    title: '导出完成',
    stage: '文件大小：2.0 KB',
    actions: [{ id: 'reveal', text: '定位文件', primary: true }],
  });

  await desktopFloatingTask.dismiss();

  assert.equal(actionTriggered, false);
});
