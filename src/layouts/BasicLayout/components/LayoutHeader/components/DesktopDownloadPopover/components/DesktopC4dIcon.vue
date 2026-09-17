<script setup lang="ts">
import { computed, useId } from 'vue';

interface Props {
  /** 图标尺寸（数字或带单位字符串） */
  size?: number | string;
}

defineOptions({ name: 'DesktopC4dIcon' });

const props = withDefaults(defineProps<Props>(), {
  size: 21,
});

const iconId = useId();

/** SVG 唯一 ID，防止同页面多实例渐变冲突 */
const screenGradId = `${iconId}-screen-grad`;
const glassShineId = `${iconId}-glass-shine`;
const bezelGradId = `${iconId}-bezel-grad`;
const standGradId = `${iconId}-stand-grad`;
const baseGradId = `${iconId}-base-grad`;
const waveGradId = `${iconId}-wave-grad`;
const glowFilterId = `${iconId}-glow`;

const sizePx = computed(() => (typeof props.size === 'number' ? `${props.size}px` : props.size));
</script>

<template>
  <svg
    class="desktop-c4d-icon"
    :width="sizePx"
    :height="sizePx"
    viewBox="0 0 32 32"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    focusable="false"
  >
    <defs>
      <!-- 屏幕未来感霓虹多色渐变（C4D 视觉核心） -->
      <linearGradient :id="screenGradId" x1="4" y1="5" x2="28" y2="23" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#4F46E5" />
        <stop offset="42%" stop-color="#7C3AED" />
        <stop offset="78%" stop-color="#A855F7" />
        <stop offset="100%" stop-color="#EC4899" />
      </linearGradient>

      <!-- 玻璃拟态斜切高光反射 -->
      <linearGradient :id="glassShineId" x1="5" y1="5" x2="24" y2="22" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.55" />
        <stop offset="35%" stop-color="#FFFFFF" stop-opacity="0.22" />
        <stop offset="70%" stop-color="#FFFFFF" stop-opacity="0.04" />
        <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0" />
      </linearGradient>

      <!-- 外边框钛合金/铝合金质感渐变 -->
      <linearGradient :id="bezelGradId" x1="2" y1="3" x2="30" y2="25" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#CBD5E1" />
        <stop offset="50%" stop-color="#94A3B8" />
        <stop offset="100%" stop-color="#64748B" />
      </linearGradient>

      <!-- 金属支架立柱立体渐变 -->
      <linearGradient :id="standGradId" x1="14" y1="21" x2="18" y2="26" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#94A3B8" />
        <stop offset="50%" stop-color="#F8FAFC" />
        <stop offset="100%" stop-color="#64748B" />
      </linearGradient>

      <!-- 底座悬浮立体阴影与反射渐变 -->
      <linearGradient :id="baseGradId" x1="9" y1="26" x2="23" y2="29" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#E2E8F0" />
        <stop offset="50%" stop-color="#F8FAFC" />
        <stop offset="100%" stop-color="#94A3B8" />
      </linearGradient>

      <!-- 屏幕波形微光渐变 -->
      <linearGradient :id="waveGradId" x1="8" y1="14" x2="24" y2="14" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#38BDF8" stop-opacity="0.8" />
        <stop offset="50%" stop-color="#FFFFFF" stop-opacity="0.95" />
        <stop offset="100%" stop-color="#F472B6" stop-opacity="0.8" />
      </linearGradient>

      <!-- 荧光光晕滤镜 -->
      <filter :id="glowFilterId" x="-10%" y="-10%" width="120%" height="120%">
        <feDropShadow dx="0" dy="1.5" stdDeviation="1.5" flood-color="#8B5CF6" flood-opacity="0.45" />
      </filter>
    </defs>

    <!-- 1. 底座与立柱（C4D 3D 悬浮支架） -->
    <g class="c4d-stand-group">
      <!-- 阴影椭圆 -->
      <ellipse cx="16" cy="28.5" rx="7.5" ry="1.2" fill="rgba(15, 23, 42, 0.18)" class="c4d-ground-shadow" />
      <!-- 立柱主体 -->
      <path d="M14.5 20.5H17.5L18 26.5H14L14.5 20.5Z" :fill="`url(#${standGradId})`" />
      <!-- 倒梯形立体底座 -->
      <path
        d="M10.2 26.5H21.8C22.4 26.5 22.8 26.9 22.6 27.5L22.2 28.3C22 28.7 21.6 29 21.1 29H10.9C10.4 29 10 28.7 9.8 28.3L9.4 27.5C9.2 26.9 9.6 26.5 10.2 26.5Z"
        :fill="`url(#${baseGradId})`"
        stroke="rgba(148, 163, 184, 0.4)"
        stroke-width="0.5"
      />
    </g>

    <!-- 2. 显示器外框（3D 圆角矩形） -->
    <g class="c4d-monitor-group" :filter="`url(#${glowFilterId})`">
      <!-- 外壳背板与金属边框 -->
      <rect
        x="3"
        y="4"
        width="26"
        height="17.5"
        rx="3"
        :fill="`url(#${bezelGradId})`"
        stroke="rgba(255, 255, 255, 0.6)"
        stroke-width="0.6"
        class="c4d-bezel"
      />

      <!-- 屏幕内嵌视窗（深度内陷感） -->
      <rect
        x="4.2"
        y="5.2"
        width="23.6"
        height="14.8"
        rx="2"
        :fill="`url(#${screenGradId})`"
        class="c4d-screen"
      />

      <!-- 3. 屏幕细节元素：macOS 风格三色交通灯控制点 -->
      <circle cx="6.5" cy="7.2" r="0.75" fill="#FF5F56" />
      <circle cx="8.5" cy="7.2" r="0.75" fill="#FFBD2E" />
      <circle cx="10.5" cy="7.2" r="0.75" fill="#27C93F" />

      <!-- 4. 屏幕界面波形与代码块（未来科技感） -->
      <!-- 顶部轻微代码行 -->
      <rect x="13" y="6.8" width="5.5" height="0.8" rx="0.4" fill="rgba(255, 255, 255, 0.45)" />
      <rect x="19.5" y="6.8" width="3.5" height="0.8" rx="0.4" fill="rgba(255, 255, 255, 0.3)" />

      <!-- 中部仪表盘曲线波形 -->
      <path
        d="M6 13.5L9 11.8L12.5 14L15.5 10.5L19 13L22 9.5L25.5 12.5"
        :stroke="`url(#${waveGradId})`"
        stroke-width="1.2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="c4d-wave-line"
      />
      <!-- 波形下微光填充 -->
      <path
        d="M6 13.5L9 11.8L12.5 14L15.5 10.5L19 13L22 9.5L25.5 12.5V17.5H6V13.5Z"
        fill="rgba(56, 189, 248, 0.12)"
      />

      <!-- 5. 玻璃拟态斜切高光反射层（Glassmorphism Sheen） -->
      <path
        d="M4.2 5.2H18.5L9 20H4.2V5.2Z"
        :fill="`url(#${glassShineId})`"
        class="c4d-glass-sheen"
      />

      <!-- 底部边框下颌高光线条 -->
      <line x1="4.2" y1="20" x2="27.8" y2="20" stroke="rgba(255, 255, 255, 0.35)" stroke-width="0.5" />
    </g>
  </svg>
</template>

<style scoped lang="less">
.desktop-c4d-icon {
  display: inline-block;
  vertical-align: middle;
  overflow: visible;
  transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), filter 0.35s ease;

  .c4d-wave-line {
    transition: stroke-dashoffset 0.8s ease;
  }

  .c4d-glass-sheen {
    transition: opacity 0.35s ease;
  }
}

:global(.header-action-btn:hover) .desktop-c4d-icon,
:global(.desktop-download-tip:hover) .desktop-c4d-icon {
  transform: translateY(-2px) scale(1.08) rotate(-1deg);
  filter: drop-shadow(0 4px 10px rgba(124, 58, 237, 0.45));

  .c4d-screen {
    filter: brightness(1.08);
  }

  .c4d-glass-sheen {
    opacity: 0.85;
  }

  .c4d-wave-line {
    animation: wave-pulse 1.8s infinite ease-in-out;
  }
}

@keyframes wave-pulse {
  0%, 100% {
    opacity: 0.85;
    stroke-width: 1.2;
  }
  50% {
    opacity: 1;
    stroke-width: 1.6;
    filter: drop-shadow(0 0 3px #38bdf8);
  }
}
</style>
