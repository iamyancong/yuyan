/**
 * 平台设置抽屉宽度，桌面端保持高级设置面板的舒展感，窄屏自动收缩。
 */
export const SETTINGS_DRAWER_WIDTH = 'min(92vw, 452px)';

/**
 * 主题模式选项。
 */
export interface ThemeModeOption {
  /** 展示名称 */
  label: string;
  /** 选项描述 */
  description: string;
  /** 是否为暗色模式 */
  value: boolean;
  /** 图标类型 */
  icon: 'light' | 'dark';
}

/**
 * 密度选项。
 */
export interface DensityOption {
  /** 展示名称 */
  label: string;
  /** 选项描述 */
  description: string;
  /** 是否为紧凑模式 */
  value: boolean;
}

/**
 * 预设主题色配置。
 */
export interface ThemePresetColor {
  /** 色彩名称 */
  label: string;
  /** 主色值 */
  value: string;
  /** 用于渐变高光的辅助色 */
  glow: string;
}

/**
 * 平台设置中的主题模式选项。
 */
export const THEME_MODE_OPTIONS: ThemeModeOption[] = [
  { label: '亮色', description: '明亮清爽', value: false, icon: 'light' },
  { label: '暗色', description: '低光专注', value: true, icon: 'dark' },
];

/**
 * 平台设置中的密度选项。
 */
export const DENSITY_OPTIONS: DensityOption[] = [
  { label: '默认', description: '平衡留白', value: false },
  { label: '紧凑', description: '信息密集', value: true },
];

/**
 * 平台主题预设色。
 */
export const PRESET_COLORS: ThemePresetColor[] = [
  { label: '星云紫', value: '#722ED1', glow: '#B37FEB' },
  { label: '电光蓝', value: '#3371ff', glow: '#7AA2FF' },
  { label: '琥珀橙', value: '#FA8C16', glow: '#FFD591' },
  { label: '珊瑚红', value: '#F5222D', glow: '#FF7875' },
];

/**
 * 圆角滑块范围。
 */
export const BORDER_RADIUS_RANGE = {
  min: 0,
  max: 12,
};

/**
 * 布局间距滑块范围。
 */
export const SPACING_RANGE = {
  min: 8,
  max: 24,
};

/**
 * 判断颜色是否为当前激活主题色。
 * @param color 候选颜色
 * @param currentColor 当前主题色
 * @returns 是否激活
 */
export const isActiveThemeColor = (color: string, currentColor: string) => color.toLowerCase() === currentColor.toLowerCase();
