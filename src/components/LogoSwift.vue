<template>
  <svg
    :width="sizePx"
    :height="sizePx"
    viewBox="0 0 48 48"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="雨燕 Logo"
    :style="{ color: iconColor }"
  >
    <!-- 抽象雨燕剪影，使用当前颜色填充，随主题色变化 -->
    <path
      fill="currentColor"
      d="M6 30c7-10 17-18 32-20-7 6-12 12-16 18 5 2 11 3 18 2-8 3-14 3-20 2-4 3-10 6-18 6 6-3 10-6 12-8-2-3-4-5-8-8 4 1 7 2 10 3z"
      fill-opacity=".95"
    />
    <path fill="currentColor" d="M8 31c6-5 14-10 22-13-5 5-9 10-11 14 3 1 7 2 12 2-8 2-14 2-20 1 0 0 0 0 0 0z" fill-opacity=".65" />
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useTheme } from '@/hooks/useTheme';

interface Props {
  size?: number | string;
  color?: string;
  autoContrast?: boolean; // 暗色菜单下自动使用浅色以增强对比
  darkColor?: string; // 暗色菜单时使用的颜色，默认 #fff
  lightColor?: string; // 亮色菜单时使用的颜色，默认使用主题主色
}

defineOptions({ name: 'LogoSwift' });

const props = withDefaults(defineProps<Props>(), {
  size: 22,
  autoContrast: true,
  darkColor: '#ffffff',
});

const { primaryColor, menuTheme } = useTheme();

const sizePx = computed(() => (typeof props.size === 'number' ? `${props.size}px` : props.size));
const iconColor = computed(() => {
  if (props.color) return props.color;
  if (props.autoContrast) {
    return menuTheme.value === 'dark' ? props.darkColor : props.lightColor || primaryColor.value;
  }
  return primaryColor.value;
});
</script>

<style scoped>
svg {
  display: block;
  pointer-events: none;
}
</style>
