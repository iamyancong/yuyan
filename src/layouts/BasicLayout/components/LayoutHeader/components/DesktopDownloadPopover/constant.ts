import type { PlatformInfo } from '@/utils/platformDetect';

/** 平台标识键 */
export type PlatformKey = 'darwin-arm64' | 'darwin-x64' | 'windows-x64';

/** CPU 架构类型 */
export type ArchType = 'aarch64' | 'x86_64';

/** 操作系统类型 */
export type OsType = 'darwin' | 'windows';

/** 下载平台选项定义 */
export interface DownloadPlatformOption {
  /** 唯一标识 */
  key: PlatformKey;
  /** 平台 */
  platform: OsType;
  /** 架构 */
  arch: ArchType;
  /** 平台标题 */
  title: string;
  /** 芯片/系统详细说明 */
  desc: string;
  /** 主 CTA 按钮单例文案（精炼短文案） */
  ctaLabel: string;
  /** 主 CTA 双层排版主标题 */
  ctaTitle: string;
  /** 主 CTA 智能推荐说明 */
  ctaRecommendDesc: string;
  /** 图标类型 */
  icon: 'apple' | 'windows';
  /** 安装包后缀 */
  ext: '.dmg' | '.exe';
}

/** 所有支持的桌面端平台安装包配置 */
export const SUPPORTED_DOWNLOAD_PLATFORMS: DownloadPlatformOption[] = [
  {
    key: 'darwin-arm64',
    platform: 'darwin',
    arch: 'aarch64',
    title: 'macOS (Apple Silicon)',
    desc: '适用于 M1 / M2 / M3 / M4 及后续芯片',
    ctaLabel: '下载 macOS 版 (Apple 芯片)',
    ctaTitle: '下载 macOS 桌面端',
    ctaRecommendDesc: '智能匹配 · Apple Silicon (M系列)',
    icon: 'apple',
    ext: '.dmg',
  },
  {
    key: 'darwin-x64',
    platform: 'darwin',
    arch: 'x86_64',
    title: 'macOS (Intel 芯片)',
    desc: '适用于传统 Intel 处理器 Mac',
    ctaLabel: '下载 macOS 版 (Intel 芯片)',
    ctaTitle: '下载 macOS 桌面端',
    ctaRecommendDesc: '智能匹配 · Intel 处理器',
    icon: 'apple',
    ext: '.dmg',
  },
  {
    key: 'windows-x64',
    platform: 'windows',
    arch: 'x86_64',
    title: 'Windows (64位)',
    desc: '适用于 Windows 10 / 11 64位系统',
    ctaLabel: '下载 Windows 版 (64位)',
    ctaTitle: '下载 Windows 桌面端',
    ctaRecommendDesc: '智能匹配 · 64 位系统',
    icon: 'windows',
    ext: '.exe',
  },
];

/** GitHub Releases 官方发布页（内网代理离线时安全回退） */
export const GITHUB_RELEASES_URL = 'https://github.com/iamyancong/yuyan/releases/latest';

/** 首次弱引导气泡已关闭持久化键名 */
export const DESKTOP_DOWNLOAD_GUIDE_STORAGE_KEY = 'yuyan_web_desktop_download_guide_dismissed';

/** macOS Gatekeeper 首次隔离解除终端命令 */
export const MAC_QUARANTINE_COMMAND = 'sudo xattr -rd com.apple.quarantine /Applications/雨燕.app/';

/** macOS 隔离说明提示文案 */
export const MAC_QUARANTINE_TIP = '在终端 (Terminal) 粘贴执行并输入密码即可正常打开';

/**
 * 根据操作系统与 CPU 架构自动匹配默认推荐的安装包选项。
 * @param os - 探测所得操作系统
 * @param arch - 探测所得 CPU 架构
 * @returns 匹配的平台选项配置
 */
export const matchDefaultPlatform = (
  os: PlatformInfo['platform'],
  arch: PlatformInfo['arch']
): DownloadPlatformOption => {
  if (os === 'darwin') {
    return arch === 'aarch64'
      ? SUPPORTED_DOWNLOAD_PLATFORMS[0]
      : SUPPORTED_DOWNLOAD_PLATFORMS[1];
  }
  if (os === 'windows') {
    return SUPPORTED_DOWNLOAD_PLATFORMS[2];
  }
  return SUPPORTED_DOWNLOAD_PLATFORMS[0];
};

/**
 * 格式化安装包文件字节大小。
 * @param bytes - 字节数
 * @returns 格式化后的字符串（如 84.5 MB）
 */
export const formatFileSize = (bytes?: number): string => {
  if (!bytes || bytes <= 0 || Number.isNaN(bytes)) return '';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
};
