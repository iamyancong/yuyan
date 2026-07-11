/**
 * 关于雨燕组件 - 常量与类型定义
 */

/** 桌面端系统诊断信息接口 */
export interface SystemInfo {
  /** 客户端应用版本 */
  appVersion: string;
  /** Tauri 框架版本 */
  tauriVersion: string;
  /** 本地 Node.js 运行时版本 */
  nodeVersion: string;
  /** 操作系统与架构信息 */
  osInfo: string;
  /** 前端渲染内核/浏览器引擎版本 */
  renderEngine: string;
}

/** 静态文本与版权配置 */
export const ABOUT_CONFIG = {
  /** 应用显示名称 */
  appName: '雨燕 SwiftVPN',
  /** 应用简称/英文标识 */
  appKey: 'yuyan-swift-vpn',
  /** 描述文字 */
  description: '雨燕 SwiftVPN 桌面端 · 运维及部署工具',
  /** 版权所有声明 */
  copyright: '© 2026 雨燕 SwiftVPN 团队. All Rights Reserved.',
  /** 默认系统信息占位 */
  defaultInfo: (): SystemInfo => ({
    appVersion: 'Unknown',
    tauriVersion: 'Unknown',
    nodeVersion: 'Unknown',
    osInfo: 'Unknown',
    renderEngine: 'Unknown',
  })
};
