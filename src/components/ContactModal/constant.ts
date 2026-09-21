/**
 * 联系我们（技术支持）组件常量与配置定义
 */

/**
 * 技术支持联系人信息接口
 */
export interface ContactInfo {
  /** 姓名 */
  name: string;
  /** 工号 */
  workNo: string;
  /** 公司或归属 */
  company: string;
  /** 部门职责/技术支持标签 */
  role: string;
  /** 工作邮箱（企微主搜索凭证） */
  email: string;
  /** 企业微信个人名片 H5 地址 */
  cardUrl: string;
  /** 企业微信协议唤起 scheme */
  wecomScheme: string;
  /** 快捷提示说明 */
  tipText: string;
}

/**
 * 默认联系人配置数据（优先读取本地环境变量，无环境变量时使用默认开源脱敏配置）
 */
export const CONTACT_CONFIG: ContactInfo = {
  name: (import.meta.env.VITE_CONTACT_NAME as string) || '雨燕技术支持',
  workNo: (import.meta.env.VITE_CONTACT_WORK_NO as string) || '80000000',
  company: (import.meta.env.VITE_CONTACT_COMPANY as string) || '赢时胜',
  role: (import.meta.env.VITE_CONTACT_ROLE as string) || '雨燕研发与技术支持',
  email: (import.meta.env.VITE_CONTACT_EMAIL as string) || 'support@yuyan.dev',
  cardUrl: (import.meta.env.VITE_CONTACT_CARD_URL as string) || '',
  wecomScheme: 'wxwork://',
  tipText: '支持微信 / 企业微信扫码，或在电脑上一键唤起企业微信',
};
