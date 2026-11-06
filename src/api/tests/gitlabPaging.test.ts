import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveProjectsPageTotal, resolveProjectsTotal } from '../gitlabPaging.ts';

test('x-total 解析：合法非负整数字符串按值采用', () => {
  assert.equal(resolveProjectsTotal('123', 20), 123);
  assert.equal(resolveProjectsTotal('0', 20), 0);
  assert.equal(resolveProjectsTotal(' 42 ', 20), 42);
});

test('x-total 解析：头部缺失或非字符串类型回退为本页数量', () => {
  assert.equal(resolveProjectsTotal(undefined, 20), 20);
  assert.equal(resolveProjectsTotal(null, 7), 7);
  assert.equal(resolveProjectsTotal({}, 3), 3);
  assert.equal(resolveProjectsTotal(['10'], 5), 5);
});

test('x-total 解析：空字符串不能误判为总数 0（Number("") === 0 陷阱）', () => {
  assert.equal(resolveProjectsTotal('', 20), 20);
  assert.equal(resolveProjectsTotal('   ', 20), 20);
});

test('x-total 解析：非纯数字内容一律回退', () => {
  assert.equal(resolveProjectsTotal('abc', 20), 20);
  assert.equal(resolveProjectsTotal('-5', 20), 20);
  assert.equal(resolveProjectsTotal('3.7', 20), 20);
  assert.equal(resolveProjectsTotal('Infinity', 20), 20);
  assert.equal(resolveProjectsTotal('12a', 20), 20);
});

test('x-total 解析：超出安全整数范围回退，数字类型入参按字符串规则处理', () => {
  assert.equal(resolveProjectsTotal('9007199254740993', 20), 20);
  assert.equal(resolveProjectsTotal(String(Number.MAX_SAFE_INTEGER), 1), Number.MAX_SAFE_INTEGER);
  assert.equal(resolveProjectsTotal(58, 20), 58);
  assert.equal(resolveProjectsTotal(3.7, 20), 20);
});

test('resolveProjectsPageTotal：有合法 x-total 时优先采用，不受 x-next-page 影响', () => {
  // 字符串 x-total
  assert.equal(
    resolveProjectsPageTotal({
      rawTotal: '100',
      rawNextPage: '2',
      page: 1,
      perPage: 20,
      itemsOnPage: 20,
    }),
    100
  );

  // 数字 x-total，且为 0
  assert.equal(
    resolveProjectsPageTotal({
      rawTotal: '0',
      rawNextPage: '',
      page: 1,
      perPage: 20,
      itemsOnPage: 0,
    }),
    0
  );

  // 带首尾空格的 x-total
  assert.equal(
    resolveProjectsPageTotal({
      rawTotal: ' 45 ',
      rawNextPage: '3',
      page: 2,
      perPage: 20,
      itemsOnPage: 20,
    }),
    45
  );
});

test('resolveProjectsPageTotal：无 x-total 但有合法 x-next-page 时返回 page * perPage + 1', () => {
  // rawNextPage 为非空字符串 "2"
  assert.equal(
    resolveProjectsPageTotal({
      rawTotal: undefined,
      rawNextPage: '2',
      page: 1,
      perPage: 20,
      itemsOnPage: 20,
    }),
    21
  );

  // 第 2 页，pageSize 10，rawNextPage 为数字 3
  assert.equal(
    resolveProjectsPageTotal({
      rawTotal: '',
      rawNextPage: 3,
      page: 2,
      perPage: 10,
      itemsOnPage: 10,
    }),
    21
  );

  // rawNextPage 带空白字符
  assert.equal(
    resolveProjectsPageTotal({
      rawTotal: null,
      rawNextPage: ' 4 ',
      page: 3,
      perPage: 15,
      itemsOnPage: 15,
    }),
    46
  );
});

test('resolveProjectsPageTotal：无 x-total 且无 x-next-page 时按最后一页精确计算', () => {
  // 第 1 页就是最后一页（共 12 条）
  assert.equal(
    resolveProjectsPageTotal({
      rawTotal: undefined,
      rawNextPage: undefined,
      page: 1,
      perPage: 20,
      itemsOnPage: 12,
    }),
    12
  );

  // 第 2 页是最后一页（第 1 页 20 条，本页 7 条，共 27 条）
  assert.equal(
    resolveProjectsPageTotal({
      rawTotal: '',
      rawNextPage: '',
      page: 2,
      perPage: 20,
      itemsOnPage: 7,
    }),
    27
  );

  // rawNextPage 为 0 或负数或空对象，不视为有效下一页
  assert.equal(
    resolveProjectsPageTotal({
      rawTotal: 'abc',
      rawNextPage: 0,
      page: 2,
      perPage: 20,
      itemsOnPage: 5,
    }),
    25
  );

  assert.equal(
    resolveProjectsPageTotal({
      rawTotal: null,
      rawNextPage: '   ',
      page: 1,
      perPage: 20,
      itemsOnPage: 0,
    }),
    0
  );
});

test('resolveProjectsPageTotal：page / perPage 缺省或非法时采用安全默认值', () => {
  // page / perPage 缺省，且有 next-page：safePage=1, safePerPage=20 -> 1 * 20 + 1 = 21
  assert.equal(
    resolveProjectsPageTotal({
      rawTotal: undefined,
      rawNextPage: '2',
      itemsOnPage: 20,
    }),
    21
  );

  // page / perPage 缺省，无 next-page：safePage=1, safePerPage=20 -> (1 - 1) * 20 + 8 = 8
  assert.equal(
    resolveProjectsPageTotal({
      rawTotal: undefined,
      rawNextPage: undefined,
      itemsOnPage: 8,
    }),
    8
  );

  // page 为非法负数 / NaN，perPage 为 0 / 负数，且有 next-page：安全回退为 safePage=1, safePerPage=20 -> 21
  assert.equal(
    resolveProjectsPageTotal({
      rawTotal: undefined,
      rawNextPage: '2',
      page: -1,
      perPage: 0,
      itemsOnPage: 20,
    }),
    21
  );

  // page 为小数或 NaN，按安全默认 safePage=1
  assert.equal(
    resolveProjectsPageTotal({
      rawTotal: undefined,
      rawNextPage: '2',
      page: Number.NaN,
      perPage: 10,
      itemsOnPage: 10,
    }),
    11
  );
});
