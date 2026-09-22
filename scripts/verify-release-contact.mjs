#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

/** 正式安装包必须注入的技术支持字段；公司和职责允许沿用通用文案。 */
const CONTACT_FIELDS = {
  VITE_CONTACT_NAME: '雨燕技术支持',
  VITE_CONTACT_WORK_NO: '80000000',
  VITE_CONTACT_COMPANY: '',
  VITE_CONTACT_ROLE: '',
  VITE_CONTACT_EMAIL: 'support@yuyan.dev',
  VITE_CONTACT_CARD_URL: '',
};

/**
 * 校验发版联系人配置，仅报告字段名，不向构建日志输出联系人内容。
 * @param {Record<string, string | undefined>} env 构建进程环境变量。
 * @returns {void} 配置不完整或仍使用占位值时抛出异常，阻止发版。
 */
export function verifyReleaseContact(env) {
  const invalidFields = new Set();
  for (const [key, placeholder] of Object.entries(CONTACT_FIELDS)) {
    const value = env[key]?.trim() || '';
    if (!value || value.toLowerCase() === placeholder.toLowerCase() || /[\r\n]/.test(value)) {
      invalidFields.add(key);
    }
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.VITE_CONTACT_EMAIL || '')) {
    invalidFields.add('VITE_CONTACT_EMAIL');
  }
  try {
    const cardUrl = new URL(env.VITE_CONTACT_CARD_URL || '');
    if (!['https:', 'http:'].includes(cardUrl.protocol)) {
      invalidFields.add('VITE_CONTACT_CARD_URL');
    }
  } catch {
    invalidFields.add('VITE_CONTACT_CARD_URL');
  }

  if (invalidFields.size > 0) {
    throw new Error(
      `联系人发版配置无效：${[...invalidFields].join(', ')}。请检查仓库 Actions Secrets 与 release-tauri.yml 的环境变量注入；所有字段必须非空，姓名/工号/邮箱不得使用开源占位值，邮箱及 HTTP(S) 名片地址必须有效。`
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    verifyReleaseContact(process.env);
    console.log('[release-contact] 联系人配置校验通过（6 个字段）。');
  } catch (error) {
    console.error(`[release-contact] ${error.message}`);
    process.exitCode = 1;
  }
}
