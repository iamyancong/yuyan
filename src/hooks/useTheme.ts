import { computed, reactive, toRefs, watch } from 'vue';
import { theme as antdTheme } from 'ant-design-vue';

export type MenuTheme = 'light' | 'dark';

interface ThemeState {
  primaryColor: string;
  menuTheme: MenuTheme;
  isDark: boolean;
  isCompact: boolean;
  borderRadius: number;
}

const STORAGE_KEY = 'yuyan-ops-theme';

function loadFromStorage(): ThemeState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { primaryColor: '#722ED1', menuTheme: 'light', isDark: false, isCompact: false, borderRadius: 6 };
    const parsed = JSON.parse(raw) as Partial<ThemeState>;
    return {
      primaryColor: parsed.primaryColor || '#722ED1',
      menuTheme: (parsed.menuTheme as MenuTheme) || 'dark',
      isDark: typeof parsed.isDark === 'boolean' ? parsed.isDark : false,
      isCompact: typeof parsed.isCompact === 'boolean' ? parsed.isCompact : false,
      borderRadius: typeof parsed.borderRadius === 'number' ? parsed.borderRadius : 6,
    };
  } catch {
    return { primaryColor: '#722ED1', menuTheme: 'dark', isDark: false, isCompact: false, borderRadius: 6 };
  }
}

const themeState = reactive<ThemeState>(loadFromStorage());

/**
 * 动态同步应用图标（暗夜霓虹玻璃 / 晨曦微光白玉）
 * @param isDark 是否为暗黑模式
 */
function syncAppIcon(isDark: boolean) {
  try {
    // 动态引入 tauri api，兼容浏览器开发环境
    import('@tauri-apps/api/core')
      .then(({ invoke }) => {
        invoke('change_app_icon', { isDark }).catch((err) => {
          console.error('Failed to change app icon via Tauri:', err);
        });
      })
      .catch(() => {
        // 非 Tauri 环境下忽略
      });
  } catch {
    // 忽略
  }
}

/**
 * 将关键主题语义同步为全局 CSS 变量，供自定义样式使用
 * 这样可以避免暗色模式下出现白底/浅色边框的问题
 */
function syncCssVariables() {
  const root = document.documentElement;
  const isDark = themeState.isDark;
  const primaryColor = themeState.primaryColor;

  // 基础颜色
  const textColor = isDark ? '#e8e8e8' : 'rgba(0, 0, 0, 0.88)';
  const textColorSecondary = isDark ? '#a6a6a6' : 'rgba(0, 0, 0, 0.45)';
  const textColorTertiary = isDark ? '#8c8c8c' : 'rgba(0, 0, 0, 0.25)';
  const bgColor = isDark ? '#141414' : '#f0f2f5';
  const bgColorContainer = isDark ? '#1f1f1f' : '#ffffff';
  const bgColorElevated = isDark ? '#262626' : '#fafafa';
  const borderColor = isDark ? '#424242' : '#d9d9d9';
  const borderColorSplit = isDark ? '#303030' : '#f0f0f0';
  const codeBg = isDark ? '#0b1220' : '#f6f8fa';

  // 主题色变体
  const primaryColorHover = isDark ? lightenColor(primaryColor, 10) : darkenColor(primaryColor, 5);
  const primaryColorActive = isDark ? lightenColor(primaryColor, 15) : darkenColor(primaryColor, 10);
  const primaryColorLight = isDark ? addOpacity(primaryColor, 0.2) : addOpacity(primaryColor, 0.1);
  const primaryColorLighter = isDark ? addOpacity(primaryColor, 0.1) : addOpacity(primaryColor, 0.06);
  const vxePrimaryLighten = lightenColor(primaryColor, 15);
  const vxePrimaryDarken = darkenColor(primaryColor, 10);

  // 语义化颜色
  const successColor = isDark ? '#52c41a' : '#52c41a';
  const warningColor = isDark ? '#faad14' : '#faad14';
  const errorColor = isDark ? '#ff4d4f' : '#ff4d4f';
  const infoColor = primaryColor;

  // 设置CSS变量
  root.style.setProperty('--text-color', textColor);
  root.style.setProperty('--text-color-secondary', textColorSecondary);
  root.style.setProperty('--text-color-tertiary', textColorTertiary);
  root.style.setProperty('--bg-color', bgColor);
  root.style.setProperty('--bg-color-container', bgColorContainer);
  root.style.setProperty('--bg-color-elevated', bgColorElevated);
  root.style.setProperty('--border-color', borderColor);
  root.style.setProperty('--border-color-split', borderColorSplit);
  root.style.setProperty('--code-bg', codeBg);

  // 主题色变体
  root.style.setProperty('--primary-color', primaryColor);
  root.style.setProperty('--primary-color-hover', primaryColorHover);
  root.style.setProperty('--primary-color-active', primaryColorActive);
  root.style.setProperty('--primary-color-light', primaryColorLight);
  root.style.setProperty('--primary-color-lighter', primaryColorLighter);

  // vxe-table 会在 data-vxe-ui-theme 下声明默认蓝色变量，需要直接写入根节点内联变量覆盖。
  root.setAttribute('data-vxe-ui-theme', isDark ? 'dark' : 'light');
  root.style.setProperty('--vxe-primary-color', primaryColor);
  root.style.setProperty('--vxe-primary-lighten-color', vxePrimaryLighten);
  root.style.setProperty('--vxe-ui-font-primary-color', primaryColor);
  root.style.setProperty('--vxe-ui-font-primary-hover-color', primaryColorLighter);
  root.style.setProperty('--vxe-ui-font-primary-tinge-color', primaryColorLighter);
  root.style.setProperty('--vxe-ui-font-primary-lighten-color', vxePrimaryLighten);
  root.style.setProperty('--vxe-ui-font-primary-darken-color', vxePrimaryDarken);
  root.style.setProperty('--vxe-ui-font-primary-disabled-color', addOpacity(primaryColor, 0.45));
  root.style.setProperty('--vxe-ui-loading-color', primaryColor);
  root.style.setProperty('--vxe-ui-table-resizable-drag-line-color', primaryColor);
  root.style.setProperty('--vxe-ui-toolbar-custom-active-background-color', primaryColorLight);
  root.style.setProperty('--vxe-ui-table-column-hover-background-color', primaryColorLighter);
  root.style.setProperty('--vxe-ui-table-column-current-background-color', primaryColorLighter);
  root.style.setProperty('--vxe-ui-table-column-hover-current-background-color', primaryColorLight);
  root.style.setProperty('--vxe-ui-table-row-hover-background-color', primaryColorLighter);
  root.style.setProperty('--vxe-ui-table-row-current-background-color', primaryColorLighter);
  root.style.setProperty('--vxe-ui-table-row-hover-current-background-color', primaryColorLight);
  root.style.setProperty('--vxe-ui-table-drag-over-background-color', primaryColorLight);
  root.style.setProperty('--vxe-ui-table-cell-area-border-color', primaryColor);
  root.style.setProperty('--vxe-ui-table-cell-main-area-extension-background-color', primaryColor);
  root.style.setProperty('--vxe-ui-table-cell-area-background-color', primaryColorLight);
  root.style.setProperty('--vxe-ui-table-cell-area-status-background-color', primaryColorLighter);
  root.style.setProperty('--vxe-ui-table-checkbox-range-border-color', primaryColor);
  root.style.setProperty('--vxe-ui-table-checkbox-range-background-color', primaryColorLight);

  // 语义化颜色
  root.style.setProperty('--success-color', successColor);
  root.style.setProperty('--warning-color', warningColor);
  root.style.setProperty('--error-color', errorColor);
  root.style.setProperty('--info-color', infoColor);

  // 联动同步应用图标
  syncAppIcon(isDark);
}

// 颜色工具函数
const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
};

const lightenColor = (hex: string, percent: number): string => {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;

  const { r, g, b } = rgb;
  const amount = Math.round(2.55 * percent);

  const newR = Math.min(255, r + amount);
  const newG = Math.min(255, g + amount);
  const newB = Math.min(255, b + amount);

  return `#${((1 << 24) + (newR << 16) + (newG << 8) + newB).toString(16).slice(1)}`;
};

const darkenColor = (hex: string, percent: number): string => {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;

  const { r, g, b } = rgb;
  const amount = Math.round(2.55 * percent);

  const newR = Math.max(0, r - amount);
  const newG = Math.max(0, g - amount);
  const newB = Math.max(0, b - amount);

  return `#${((1 << 24) + (newR << 16) + (newG << 8) + newB).toString(16).slice(1)}`;
};

const addOpacity = (hex: string, opacity: number): string => {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;

  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
};

// 初始化一次 CSS 变量
syncCssVariables();

watch(
  () => ({ ...themeState }),
  (value) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {}
    // 每次主题相关状态变更时，同步 CSS 变量
    syncCssVariables();
  },
  { deep: true }
);

const themeConfig = computed(() => {
  const algorithms: any[] = [];
  if (themeState.isDark && (antdTheme as any).darkAlgorithm) algorithms.push((antdTheme as any).darkAlgorithm);
  if (themeState.isCompact && (antdTheme as any).compactAlgorithm) algorithms.push((antdTheme as any).compactAlgorithm);
  const algorithm = algorithms.length > 0 ? algorithms : (antdTheme as any).defaultAlgorithm;
  return {
    token: {
      colorPrimary: themeState.primaryColor,
      borderRadius: themeState.borderRadius,
    },
    algorithm,
  };
});

function setPrimaryColor(color: string) {
  themeState.primaryColor = color;
}

function setMenuTheme(theme: MenuTheme) {
  themeState.menuTheme = theme;
}

function toggleMenuTheme() {
  themeState.menuTheme = themeState.menuTheme === 'dark' ? 'light' : 'dark';
}

function setDarkMode(next: boolean) {
  themeState.isDark = next;
}

function setCompact(next: boolean) {
  themeState.isCompact = next;
}

function setBorderRadius(next: number) {
  themeState.borderRadius = next;
}

function resetTheme() {
  themeState.primaryColor = '#722ED1';
  themeState.menuTheme = 'dark';
  themeState.isDark = false;
  themeState.isCompact = false;
  themeState.borderRadius = 6;
}

export function useTheme() {
  return {
    ...toRefs(themeState),
    themeConfig,
    setPrimaryColor,
    setMenuTheme,
    toggleMenuTheme,
    setDarkMode,
    setCompact,
    setBorderRadius,
    resetTheme,
  };
}
