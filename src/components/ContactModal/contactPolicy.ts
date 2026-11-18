/**
 * 技术支持联系人配置与展示策略（纯函数，便于在 Node 测试中直接运行）
 */

/**
 * 技术支持联系人信息接口
 */
export interface ContactInfo {
  /** 姓名或支持渠道标题 */
  name: string;
  /** 工号（未配置时为空串） */
  workNo: string;
  /** 公司或归属 */
  company: string;
  /** 部门职责/技术支持标签 */
  role: string;
  /** 工作邮箱（企微主搜索凭证，未配置时为空串） */
  email: string;
  /** 企业微信个人名片 H5 地址（未配置时为空串） */
  cardUrl: string;
  /** 企业微信协议唤起 scheme */
  wecomScheme: string;
  /** 快捷提示说明 */
  tipText: string;
}

/** 构建期注入的联系人环境变量（来自 import.meta.env 或测试桩） */
export type ContactEnv = Partial<Record<string, string | boolean | undefined>>;

/** 联系人各区块的显示开关 */
export interface ContactVisibility {
  /** 显示邮箱行、「复制邮箱」与「在电脑企微中联系我」按钮 */
  showEmail: boolean;
  /** 显示工号行 */
  showWorkNo: boolean;
  /** 显示「网页名片」按钮 */
  showCardUrl: boolean;
  /** 邮箱、工号、名片都未配置：显示中性提示，替代空白信息区 */
  showEmptyHint: boolean;
}

/** 未配置任何文字联系方式时的提示文案 */
export const CONTACT_EMPTY_HINT = '暂未配置邮箱等联系方式，请扫码或联系管理员';

/**
 * 读取并去除首尾空白；非字符串（如 Vite 内置布尔量）视为未配置。
 * @param {ContactEnv} env 环境变量对象。
 * @param {string} key 变量名。
 * @returns {string} 去空白后的值，未配置时为空串。
 */
const readEnv = (env: ContactEnv, key: string): string => {
  const value = env[key];
  return typeof value === 'string' ? value.trim() : '';
};

/**
 * 根据构建期环境变量生成联系人配置。
 * @description 工号、邮箱、名片没有默认值，避免占位信息冒充真实联系人；
 *   标题类字段（姓名/公司/职责）保留通用文案，仅用于描述支持渠道。
 * @param {ContactEnv} env 构建期环境变量。
 * @returns {ContactInfo} 联系人配置。
 */
export const buildContactConfig = (env: ContactEnv): ContactInfo => ({
  name: readEnv(env, 'VITE_CONTACT_NAME') || '雨燕技术支持',
  workNo: readEnv(env, 'VITE_CONTACT_WORK_NO'),
  company: readEnv(env, 'VITE_CONTACT_COMPANY') || '赢时胜',
  role: readEnv(env, 'VITE_CONTACT_ROLE') || '雨燕研发与技术支持',
  email: readEnv(env, 'VITE_CONTACT_EMAIL'),
  cardUrl: readEnv(env, 'VITE_CONTACT_CARD_URL'),
  wecomScheme: 'wxwork://',
  tipText: '支持微信 / 企业微信扫码，或在电脑上一键唤起企业微信',
});

/**
 * 计算联系人各区块是否显示。
 * @param {Pick<ContactInfo, 'email' | 'workNo' | 'cardUrl'>} info 联系人配置。
 * @returns {ContactVisibility} 显示开关。
 */
export const resolveContactVisibility = (
  info: Pick<ContactInfo, 'email' | 'workNo' | 'cardUrl'>
): ContactVisibility => {
  const showEmail = Boolean(info.email.trim());
  const showWorkNo = Boolean(info.workNo.trim());
  const showCardUrl = Boolean(info.cardUrl.trim());
  return {
    showEmail,
    showWorkNo,
    showCardUrl,
    showEmptyHint: !showEmail && !showWorkNo && !showCardUrl,
  };
};
