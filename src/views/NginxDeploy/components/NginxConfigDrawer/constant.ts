/**
 * Nginx 配置文件管理常量与工具函数
 */

/** 接口：Nginx 配置文件读取结果 */
export interface NginxConfigResult {
  /** 文件路径 */
  path: string;
  /** 文件内容 */
  content: string;
}

/**
 * 提取操作错误文案。
 * @param error 错误对象
 * @returns 错误文案
 */
export const getErrorMessage = (error: any): string => {
  return error?.response?.data?.error || error?.response?.data?.message || error?.message || '操作失败';
};
