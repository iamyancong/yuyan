import assert from 'node:assert/strict';
import test from 'node:test';
import { ref } from 'vue';
import { hasAnyVisibleOverlay } from '../constant.ts';

test('hasAnyVisibleOverlay: 空状态与全关闭时返回 false', () => {
  assert.equal(hasAnyVisibleOverlay(null), false);
  assert.equal(hasAnyVisibleOverlay(undefined), false);
  assert.equal(hasAnyVisibleOverlay({}), false);
  assert.equal(
    hasAnyVisibleOverlay({
      serverState: { serverModalOpen: false, runtimeDrawerOpen: false, fsDrawerOpen: false },
      targetState: { targetModalOpen: false, nginxTargetId: null },
    }),
    false
  );
});

test('hasAnyVisibleOverlay: 仅打开服务器远程目录浏览 fsDrawerOpen 时正确返回 true', () => {
  // 模拟仅点击“浏览目录”触发 fsDrawerOpen (原生 boolean 与 Ref)
  const plainState = {
    serverState: { fsDrawerOpen: true },
  };
  assert.equal(hasAnyVisibleOverlay(plainState), true);

  const refState = {
    serverState: {
      serverModalOpen: ref(false),
      runtimeDrawerOpen: ref(false),
      fsDrawerOpen: ref(true),
    },
  };
  assert.equal(hasAnyVisibleOverlay(refState), true);
});

test('hasAnyVisibleOverlay: 其他弹层或抽屉独立激活时均能正确判定', () => {
  assert.equal(hasAnyVisibleOverlay({ serverState: { serverModalOpen: true } }), true);
  assert.equal(hasAnyVisibleOverlay({ serverState: { runtimeDrawerOpen: true } }), true);
  assert.equal(hasAnyVisibleOverlay({ targetState: { targetModalOpen: true } }), true);
  assert.equal(hasAnyVisibleOverlay({ targetState: { nginxTargetId: 101 } }), true);
  assert.equal(hasAnyVisibleOverlay({ targetState: { serviceLogOpen: true } }), true);
  assert.equal(hasAnyVisibleOverlay({ targetState: { javaManagerOpen: true } }), true);
  assert.equal(hasAnyVisibleOverlay({ targetState: { environmentManagerOpen: true } }), true);
  assert.equal(hasAnyVisibleOverlay({ recordState: { recordLogOpen: true } }), true);
  assert.equal(hasAnyVisibleOverlay({ progressState: { publishConfirmOpen: true } }), true);
  assert.equal(hasAnyVisibleOverlay({ progressState: { rollbackProgressOpen: true } }), true);
  assert.equal(hasAnyVisibleOverlay({ progressState: { rollbackConfirmOpen: true } }), true);
  assert.equal(hasAnyVisibleOverlay({ openApiState: { drawerOpen: true } }), true);
});
