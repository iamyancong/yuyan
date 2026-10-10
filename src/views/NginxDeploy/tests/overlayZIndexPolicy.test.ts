import assert from 'node:assert/strict';
import test from 'node:test';
import { OVERLAY_Z_INDEX } from '../constant.ts';

test('OVERLAY_Z_INDEX: 验证弹窗与抽屉层级关系符合设计规范', () => {
  // 1. 确保一级弹窗基准层级与 AntDV 默认对齐
  assert.equal(OVERLAY_Z_INDEX.modal, 1000);

  // 2. 确保从弹窗中呼出的抽屉层级严格高于弹窗
  assert.equal(OVERLAY_Z_INDEX.drawerAboveModal, 1010);
  assert.ok(
    OVERLAY_Z_INDEX.drawerAboveModal > OVERLAY_Z_INDEX.modal,
    '二级抽屉的 zIndex 必须严格大于一级弹窗，避免 DOM 插入顺序引发压盖'
  );

  // 3. 确保从抽屉内呼出的确认弹窗高于抽屉本身
  assert.equal(OVERLAY_Z_INDEX.modalAboveDrawer, 1020);
  assert.ok(
    OVERLAY_Z_INDEX.modalAboveDrawer > OVERLAY_Z_INDEX.drawerAboveModal,
    '抽屉内呼出的 Modal.confirm 必须高于抽屉层级'
  );

  // 4. 确保抽屉层级低于常规 AntDV 内部浮层（Popconfirm: 1030, Select Dropdown: 1050, Tooltip/Popover: 1060）
  const ANTD_POPCONFIRM_Z_INDEX = 1030;
  const ANTD_SELECT_DROPDOWN_Z_INDEX = 1050;
  const PROJECT_CUSTOM_POPOVER_Z_INDEX = 1060;

  assert.ok(
    OVERLAY_Z_INDEX.drawerAboveModal < ANTD_POPCONFIRM_Z_INDEX,
    '抽屉层级必须低于 Popconfirm，确保抽屉内的二次确认气泡正常显示'
  );
  assert.ok(
    OVERLAY_Z_INDEX.drawerAboveModal < ANTD_SELECT_DROPDOWN_Z_INDEX,
    '抽屉层级必须低于 Select Dropdown，确保抽屉内的下拉菜单正常显示'
  );
  assert.ok(
    OVERLAY_Z_INDEX.drawerAboveModal < PROJECT_CUSTOM_POPOVER_Z_INDEX,
    '抽屉层级必须低于自定义气泡卡片，避免层级冲突'
  );
});
