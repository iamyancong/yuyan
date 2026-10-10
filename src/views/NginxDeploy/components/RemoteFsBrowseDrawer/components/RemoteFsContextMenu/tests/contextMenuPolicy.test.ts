import assert from 'node:assert/strict';
import test from 'node:test';
import type { RemoteFsEntry } from '../../../../../../../api/deploy.ts';
import { useContextMenu } from '../../../hooks/useContextMenu.ts';
import {
  createContextMenuPointerGuard,
  handleContextMenuKeyDown,
  handleContextMenuPointerDown,
  isTableAreaElement,
} from '../hooks/useContextMenuDom.ts';

test('RemoteFsContextMenu: ESC 按键在菜单可见时拦截事件、阻止穿透并关闭菜单', () => {
  let prevented = false;
  let stopped = false;
  let stopImmediateCalled = false;
  let closed = false;

  const mockEscEvent = {
    key: 'Escape',
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
    stopImmediatePropagation: () => {
      stopImmediateCalled = true;
    },
  } as unknown as KeyboardEvent;

  // 1. 菜单可见时：ESC 必须触发关闭并阻断一切下层事件（防止选区被清空或抽屉关闭）
  const consumed = handleContextMenuKeyDown(mockEscEvent, true, () => {
    closed = true;
  });

  assert.equal(consumed, true, '应当成功拦截 ESC 事件');
  assert.equal(prevented, true, '应当调用 preventDefault 阻止默认行为');
  assert.equal(stopped, true, '应当调用 stopPropagation 阻断冒泡');
  assert.equal(stopImmediateCalled, true, '应当调用 stopImmediatePropagation 阻断同级监听');
  assert.equal(closed, true, '应当触发 onClose 回调');

  // 2. 菜单关闭时：ESC 不应被拦截，交由下层处理
  prevented = false;
  stopped = false;
  stopImmediateCalled = false;
  closed = false;

  const notConsumed = handleContextMenuKeyDown(mockEscEvent, false, () => {
    closed = true;
  });

  assert.equal(notConsumed, false, '菜单关闭时不应拦截 ESC 事件');
  assert.equal(prevented, false);
  assert.equal(stopped, false);
  assert.equal(closed, false);

  // 3. 非 ESC 键（如 Enter）：不拦截
  const enterEvent = {
    key: 'Enter',
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as KeyboardEvent;

  const otherKeyConsumed = handleContextMenuKeyDown(enterEvent, true, () => {
    closed = true;
  });
  assert.equal(otherKeyConsumed, false, '非 ESC 键不应被拦截');
});

test('RemoteFsContextMenu: 外部指针点击仅在表格区域拦截防穿透，放行工具栏与关闭按钮', () => {
  let prevented = false;
  let stopped = false;
  let closed = false;

  const menuEl = {
    contains: (node: unknown) => node === 'inside-menu-target',
  } as unknown as HTMLElement;

  // 1. 左键点击表格交互区域（空白或行）：消费并阻断，防止下层表格误清空选区或误选行
  const tableTarget = {
    closest: (selector: string) => selector.includes('remote-fs-table-area'),
  };
  const tableEvent = {
    button: 0,
    target: tableTarget,
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  } as unknown as MouseEvent;

  const tableConsumed = handleContextMenuPointerDown(tableEvent, true, menuEl, () => {
    closed = true;
  });

  assert.equal(tableConsumed, true, '左键点击表格交互区应当被拦截消费');
  assert.equal(prevented, true, '应当阻止默认行为');
  assert.equal(stopped, true, '应当阻止事件冒泡');
  assert.equal(closed, true, '应当触发菜单关闭');

  // 2. 左键点击工具栏输入框或关闭按钮（非表格区域）：关闭菜单，但放行事件（不 preventDefault、不 stopPropagation）
  prevented = false;
  stopped = false;
  closed = false;

  const toolbarInputTarget = {
    closest: (_selector: string) => null,
  };
  const toolbarEvent = {
    button: 0,
    target: toolbarInputTarget,
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  } as unknown as MouseEvent;

  const toolbarConsumed = handleContextMenuPointerDown(toolbarEvent, true, menuEl, () => {
    closed = true;
  });

  assert.equal(toolbarConsumed, false, '非表格区域（工具栏输入框、关闭按钮等）不应被拦截消费');
  assert.equal(prevented, false, '不应阻止默认行为，以便输入框立即获得焦点');
  assert.equal(stopped, false, '不应阻止冒泡，以便关闭按钮或跳转动作一击即中');
  assert.equal(closed, true, '菜单本身仍应正常关闭');

  // 3. 点击菜单内部：不拦截，允许操作菜单项
  prevented = false;
  stopped = false;
  closed = false;

  const insideEvent = {
    button: 0,
    target: 'inside-menu-target',
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  } as unknown as MouseEvent;

  const insideConsumed = handleContextMenuPointerDown(insideEvent, true, menuEl, () => {
    closed = true;
  });

  assert.equal(insideConsumed, false, '菜单内部点击不应被拦截');
  assert.equal(closed, false, '菜单内部点击不应触发关闭');

  // 4. 右键（button = 2）外部点击：不拦截，允许在其他条目直接重新打开菜单
  const rightClickEvent = {
    button: 2,
    target: tableTarget,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as MouseEvent;

  const rightClickConsumed = handleContextMenuPointerDown(rightClickEvent, true, menuEl, () => {
    closed = true;
  });

  assert.equal(rightClickConsumed, false, '右键外部点击不应被拦截');
  assert.equal(closed, false);
});

test('RemoteFsContextMenu: 只有 pointerdown 没有 click 时，下一个 click 必须能正常通过不被吞掉', async () => {
  let isVisible = true;
  const menuEl = {
    contains: (node: unknown) => false,
  } as unknown as HTMLElement;

  const tableTarget = {
    closest: (selector: string) => selector.includes('remote-fs-table-area'),
  };

  const guard = createContextMenuPointerGuard({
    isVisible: () => isVisible,
    menuEl: () => menuEl,
    onClose: () => {
      isVisible = false;
    },
  });

  // 1. 模拟异常场景：用户按下了鼠标（pointerdown 触发并在表格区消费），但拖拽后切出窗口，没有触发随后的 click
  const firstPointerDown = {
    button: 0,
    target: tableTarget,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as MouseEvent;

  const consumed = guard.handlePointerDown(firstPointerDown);
  assert.equal(consumed, true, '本次 pointerdown 应当被消费并关菜单');
  assert.equal(guard.isDismissed(), true, '此时标记被置为 true');

  // 触发 pointerup，开启 setTimeout(0) 自动清理
  guard.handlePointerUp();

  // 等待宏任务 tick 执行完毕
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(guard.isDismissed(), false, '在没有 click 的情况下，pointerup 后定时器应自动清理 dismissed 标记');

  // 验证：此时用户正常点击一个按钮，触发 click，该 click 必须能正常通过，绝不能被吞掉！
  let normalClickPrevented = false;
  const normalClickEvent = {
    button: 0,
    target: tableTarget,
    preventDefault: () => {
      normalClickPrevented = true;
    },
    stopPropagation: () => {},
  } as unknown as MouseEvent;

  const clickConsumed = guard.handleClick(normalClickEvent);
  assert.equal(clickConsumed, false, '下一次正常的 click 必须能正常放行，不得被误吞');
  assert.equal(normalClickPrevented, false, '不应被调用 preventDefault');

  // 2. 模拟另一个极端场景：切窗口连 pointerup 都没收到，用户再次 pointerdown 开始新的交互
  // 先强行模拟 dismissed 标记被意外置为 true
  (guard as any).handlePointerDown({
    button: 0,
    target: tableTarget,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as MouseEvent);

  // 用户点击另一个地方，新的 pointerdown 进来（菜单已处于关闭态）
  isVisible = false;
  guard.handlePointerDown({
    button: 0,
    target: tableTarget,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as MouseEvent);

  assert.equal(guard.isDismissed(), false, '新的 pointerdown 进门必须立即清空遗留标记');

  // 随后的 click 绝不被吞
  const nextClickConsumed = guard.handleClick(normalClickEvent);
  assert.equal(nextClickConsumed, false, '新交互周期的 click 正常通过');
});

test('useContextMenu: 右键点击已有选中项时保持选区不丢失', () => {
  let exclusiveSelected: RemoteFsEntry | null = null;

  const { openContextMenu, contextMenuSelectedEntries, contextMenuTarget } = useContextMenu({
    onDownload: () => {},
    onDrillDown: () => {},
    onPreview: () => {},
    onCopyPath: () => {},
    onNavigateUp: () => {},
    onSelectExclusive: (entry) => {
      exclusiveSelected = entry;
    },
  });

  const entryA: RemoteFsEntry = {
    name: 'outsourced',
    path: '/opt/yuyan/outsourced',
    type: 'directory',
    size: null,
    mtime: null,
    permissions: 'rwxr-xr-x',
    readable: true,
  };
  const entryB: RemoteFsEntry = {
    name: 'system',
    path: '/opt/yuyan/system',
    type: 'directory',
    size: null,
    mtime: null,
    permissions: 'rwxr-xr-x',
    readable: true,
  };
  const entryC: RemoteFsEntry = {
    name: 'index.html',
    path: '/opt/yuyan/index.html',
    type: 'file',
    size: 1024,
    mtime: null,
    permissions: 'rw-r--r--',
    readable: true,
  };

  const dummyMouseEvent = { clientX: 100, clientY: 200 } as MouseEvent;

  // 1. 多选态下右键点击已选项 entryA：应保持多选区 [entryA, entryB]，不触发 onSelectExclusive
  openContextMenu(entryA, dummyMouseEvent, [entryA, entryB]);
  assert.equal(contextMenuTarget.value?.path, entryA.path);
  assert.equal(contextMenuSelectedEntries.value.length, 2);
  assert.equal(exclusiveSelected, null, '右键多选区内部条目不应触发单选重置');

  // 2. 单选态下右键点击已选中的 entryA：应保持单选 entryA，不触发 onSelectExclusive
  exclusiveSelected = null;
  openContextMenu(entryA, dummyMouseEvent, [entryA]);
  assert.equal(contextMenuTarget.value?.path, entryA.path);
  assert.equal(contextMenuSelectedEntries.value.length, 1);
  assert.equal(exclusiveSelected, null, '右键已有单选项不应触发多余的单选重置');

  // 3. 右键未选中的 entryC：应重置为当前项单选，触发 onSelectExclusive(entryC)
  exclusiveSelected = null;
  openContextMenu(entryC, dummyMouseEvent, [entryA, entryB]);
  assert.equal(contextMenuTarget.value?.path, entryC.path);
  assert.equal(contextMenuSelectedEntries.value.length, 1);
  assert.equal(contextMenuSelectedEntries.value[0]?.path, entryC.path);
  assert.equal((exclusiveSelected as RemoteFsEntry | null)?.path, entryC.path, '右键未选项应切换为单选该项');
});
