<script setup lang="ts">
import { computed, useId } from 'vue';
import { useTheme } from '@/hooks/useTheme';

interface Props {
  /** 图标尺寸 */
  size?: number | string;
  /** 显式覆盖图标主色 */
  color?: string;
  /** 是否根据菜单主题自动调整对比度 */
  autoContrast?: boolean;
  /** 暗色菜单下的图标主色 */
  darkColor?: string;
  /** 亮色菜单下的图标主色 */
  lightColor?: string;
}

defineOptions({ name: 'LogoSwift' });

const props = withDefaults(defineProps<Props>(), {
  size: 22,
  autoContrast: true,
  darkColor: '#c4b5fd',
});

const { primaryColor, menuTheme } = useTheme();
const logoId = useId();

/** SVG 使用的唯一渐变与滤镜 ID，避免同页多个 Logo 相互引用。 */
const bodyGradientId = `${logoId}-body`;
const glassGradientId = `${logoId}-glass`;
const edgeGradientId = `${logoId}-edge`;
const shadowFilterId = `${logoId}-shadow`;

/** 归一化后的 CSS 尺寸。 */
const sizePx = computed(() => (typeof props.size === 'number' ? `${props.size}px` : props.size));

/** 根据主题和显式配置计算雨燕主色。 */
const iconColor = computed(() => {
  if (props.color) return props.color;
  if (props.autoContrast) {
    return menuTheme.value === 'dark' ? props.darkColor : props.lightColor || primaryColor.value;
  }
  return primaryColor.value;
});
</script>

<template>
  <svg
    class="swift-logo"
    :width="sizePx"
    :height="sizePx"
    viewBox="0 0 64 64"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="雨燕 Logo"
    :style="{ color: iconColor }"
  >
    <defs>
      <linearGradient :id="bodyGradientId" x1="7" y1="51" x2="56" y2="10" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="currentColor" stop-opacity="0.58" />
        <stop offset="0.46" stop-color="currentColor" />
        <stop offset="1" stop-color="#67e8f9" stop-opacity="0.92" />
      </linearGradient>
      <linearGradient :id="glassGradientId" x1="18" y1="37" x2="53" y2="17" gradientUnits="userSpaceOnUse">
        <stop stop-color="#ffffff" stop-opacity="0.08" />
        <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.56" />
        <stop offset="1" stop-color="#ffffff" stop-opacity="0.04" />
      </linearGradient>
      <linearGradient :id="edgeGradientId" x1="11" y1="47" x2="52" y2="15" gradientUnits="userSpaceOnUse">
        <stop stop-color="#ffffff" stop-opacity="0.1" />
        <stop offset="0.55" stop-color="#ffffff" stop-opacity="0.9" />
        <stop offset="1" stop-color="#a5f3fc" stop-opacity="0.55" />
      </linearGradient>
      <filter :id="shadowFilterId" x="-30%" y="-30%" width="160%" height="180%" color-interpolation-filters="sRGB">
        <feDropShadow dx="0" dy="4" stdDeviation="3.4" flood-color="currentColor" flood-opacity="0.28" />
      </filter>
    </defs>

    <g :filter="`url(#${shadowFilterId})`">
      <path
        :fill="`url(#${bodyGradientId})`"
        d="M5 40.8C17.2 25.7 34.1 14.8 58.5 9.5C48 19.8 39.7 29.5 34.6 39.2C41.2 42.2 49.2 43.2 58.8 41.8C48 49.2 35.5 50.5 25.2 46.1C19.4 51.1 11.5 53.8 3.2 53.7C10.2 49.2 15.2 44.9 18.5 40.8C14.2 36.7 9.8 33.3 4.7 30.6C11.7 31.7 17.3 33.4 22 36C27.9 29.8 34.9 24.4 43.4 19.9C29.3 25.2 16.8 32.8 5 40.8Z"
      />
      <path
        :fill="`url(#${glassGradientId})`"
        d="M21.8 36.2C30.4 27.9 41.8 19.6 57.3 10.4C47.2 20.5 39.4 29.8 34.6 39.1C30.3 38.3 26 37.3 21.8 36.2Z"
      />
      <path
        fill="#ffffff"
        fill-opacity="0.2"
        d="M18.6 40.9C20.7 42.8 22.9 44.5 25.3 46.1C19.4 51.1 11.5 53.8 3.2 53.7C10.1 49.3 15.2 45 18.6 40.9Z"
      />
      <path
        :stroke="`url(#${edgeGradientId})`"
        stroke-width="1.35"
        stroke-linecap="round"
        d="M10.2 39.8C21.2 27.8 35.8 18.5 54.7 12.3"
      />
      <path
        stroke="#ffffff"
        stroke-opacity="0.46"
        stroke-width="1.1"
        stroke-linecap="round"
        d="M37.2 40.1C43.1 42.2 49.2 42.8 55.2 42.1"
      />
    </g>
    <circle cx="49.8" cy="17.1" r="1.45" fill="#ffffff" fill-opacity="0.9" />
  </svg>
</template>

<style scoped>
.swift-logo {
  display: block;
  overflow: visible;
  pointer-events: none;
  filter: saturate(1.08);
}
</style>
