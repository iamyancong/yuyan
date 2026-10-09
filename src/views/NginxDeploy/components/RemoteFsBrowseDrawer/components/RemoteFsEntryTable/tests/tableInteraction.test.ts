import assert from 'node:assert/strict';
import test from 'node:test';
import { ref } from 'vue';
import type { RemoteFsEntry } from '../../../../../../../api/deploy.ts';
import { useTableInteraction } from '../hooks/useTableInteraction.ts';

test('useTableInteraction: Shift 按下时 mousedown 拦截原生文本选区并聚焦容器', () => {
  let focused = false;
  let prevented = false;

  const mockEl = {
    focus: () => {
      focused = true;
    },
  } as unknown as HTMLElement;

  const tableAreaRef = ref<HTMLElement>(mockEl);
  const entries: RemoteFsEntry[] = [
    { name: 'assets', path: '/opt/yuyan/html/assets', type: 'directory', size: null, mtime: null, permissions: 'rwxr-xr-x', readable: true },
  ];

  const { handleMouseDown } = useTableInteraction({
    tableAreaRef,
    getEntries: () => entries,
    getSelectedCount: () => 0,
    onSelectAll: () => {},
    onClearSelection: () => {},
    onRowContextMenu: () => {},
  });

  // 1. Shift 按下时应 preventDefault 并 focus
  const shiftEvent = {
    shiftKey: true,
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as MouseEvent;

  handleMouseDown(shiftEvent);
  assert.equal(prevented, true, '应当拦截 Shift 键下的 mousedown 默认事件以杜绝原生文本选区');
  assert.equal(focused, true, '应当聚焦表格容器以便响应键盘快捷键');

  // 2. 普通点击时不 preventDefault
  prevented = false;
  focused = false;
  const normalEvent = {
    shiftKey: false,
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as MouseEvent;

  handleMouseDown(normalEvent);
  assert.equal(prevented, false, '普通鼠标点击不应被拦截');
  assert.equal(focused, false);
});

test('useTableInteraction: Cmd/Ctrl+A 全选与 ESC 清空快捷键', () => {
  let selectedAll = false;
  let cleared = false;
  let selectedCount = 2;

  const tableAreaRef = ref<HTMLElement>();
  const entries: RemoteFsEntry[] = [
    { name: 'assets', path: '/opt/yuyan/html/assets', type: 'directory', size: null, mtime: null, permissions: 'rwxr-xr-x', readable: true },
    { name: 'index.html', path: '/opt/yuyan/html/index.html', type: 'file', size: 100, mtime: null, permissions: 'rw-r--r--', readable: true },
  ];

  const { handleKeyDown } = useTableInteraction({
    tableAreaRef,
    getEntries: () => entries,
    getSelectedCount: () => selectedCount,
    onSelectAll: () => {
      selectedAll = true;
    },
    onClearSelection: () => {
      cleared = true;
    },
    onRowContextMenu: () => {},
  });

  // Cmd+A 全选
  let cmdAEventPrevented = false;
  handleKeyDown({
    metaKey: true,
    ctrlKey: false,
    key: 'a',
    preventDefault: () => {
      cmdAEventPrevented = true;
    },
  } as unknown as KeyboardEvent);
  assert.equal(selectedAll, true);
  assert.equal(cmdAEventPrevented, true);

  // ESC 清空选区（当已选数 > 0）
  let escPrevented = false;
  let escStopped = false;
  handleKeyDown({
    key: 'Escape',
    preventDefault: () => {
      escPrevented = true;
    },
    stopPropagation: () => {
      escStopped = true;
    },
  } as unknown as KeyboardEvent);
  assert.equal(cleared, true);
  assert.equal(escPrevented, true);
  assert.equal(escStopped, true);

  // 当已选数为 0 时，ESC 不应拦截或清空
  cleared = false;
  selectedCount = 0;
  escPrevented = false;
  handleKeyDown({
    key: 'Escape',
    preventDefault: () => {
      escPrevented = true;
    },
    stopPropagation: () => {},
  } as unknown as KeyboardEvent);
  assert.equal(cleared, false);
  assert.equal(escPrevented, false);
});

test('useTableInteraction: 空白区域点击清空选区，行内点击不误清空', () => {
  let cleared = false;

  const tableAreaRef = ref<HTMLElement>();
  const entries: RemoteFsEntry[] = [];

  const { handleAreaClick } = useTableInteraction({
    tableAreaRef,
    getEntries: () => entries,
    getSelectedCount: () => 1,
    onSelectAll: () => {},
    onClearSelection: () => {
      cleared = true;
    },
    onRowContextMenu: () => {},
  });

  // 1. 点击空白处
  handleAreaClick({
    target: {
      closest: (sel: string) => null,
    },
  } as unknown as MouseEvent);
  assert.equal(cleared, true);

  // 2. 点击表格行内元素时不触发清空
  cleared = false;
  handleAreaClick({
    target: {
      closest: (sel: string) => (sel === '.vxe-body--row' ? {} : null),
    },
  } as unknown as MouseEvent);
  assert.equal(cleared, false);
});
