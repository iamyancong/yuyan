import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContactConfig, resolveContactVisibility } from '../contactPolicy.ts';

test('未配置时工号、邮箱、名片为空，不再回落到占位值', () => {
  const info = buildContactConfig({});
  assert.equal(info.workNo, '');
  assert.equal(info.email, '');
  assert.equal(info.cardUrl, '');
  assert.notEqual(info.email, 'support@yuyan.dev');
  assert.notEqual(info.workNo, '80000000');
  assert.ok(info.name && info.company && info.role, '标题类字段保留通用文案');
});

test('已配置时使用注入值并去除首尾空白，非字符串视为未配置', () => {
  const info = buildContactConfig({
    VITE_CONTACT_NAME: ' 示例联系人 ',
    VITE_CONTACT_WORK_NO: '00123456',
    VITE_CONTACT_EMAIL: 'example@example.com',
    VITE_CONTACT_CARD_URL: 'https://example.com/card',
    VITE_CONTACT_COMPANY: true,
  });
  assert.equal(info.name, '示例联系人');
  assert.equal(info.workNo, '00123456');
  assert.equal(info.email, 'example@example.com');
  assert.equal(info.cardUrl, 'https://example.com/card');
  assert.equal(info.company, '赢时胜');
});

test('全部未配置时只显示中性提示', () => {
  assert.deepEqual(resolveContactVisibility(buildContactConfig({ VITE_CONTACT_EMAIL: '   ' })), {
    showEmail: false,
    showWorkNo: false,
    showCardUrl: false,
    showEmptyHint: true,
  });
});

test('部分配置时按项显示，不显示提示', () => {
  assert.deepEqual(resolveContactVisibility({ email: 'a@b.cn', workNo: '', cardUrl: '' }), {
    showEmail: true,
    showWorkNo: false,
    showCardUrl: false,
    showEmptyHint: false,
  });
  assert.deepEqual(resolveContactVisibility({ email: '', workNo: '1', cardUrl: 'https://x.cn' }), {
    showEmail: false,
    showWorkNo: true,
    showCardUrl: true,
    showEmptyHint: false,
  });
});
