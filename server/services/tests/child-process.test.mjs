import assert from 'node:assert/strict';
import test from 'node:test';
import { withHiddenWindow } from '../../utils/child-process.mjs';

test('withHiddenWindow 保留原选项并强制隐藏 Windows 控制台', () => {
  const source = { cwd: '/tmp/project', stdio: 'pipe', windowsHide: false };
  const result = withHiddenWindow(source);

  assert.deepEqual(result, {
    cwd: '/tmp/project',
    stdio: 'pipe',
    windowsHide: true,
  });
  assert.equal(source.windowsHide, false);
});
