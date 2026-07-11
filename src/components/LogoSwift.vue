<template>
  <div 
    class="logo-swift-wrapper" 
    :style="wrapperStyle"
    role="img"
    aria-label="雨燕 SwiftVPN Logo"
  >
    <img 
      src="@/assets/logo.png" 
      alt="Logo" 
      class="logo-image" 
      :class="[menuTheme]"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useTheme } from '@/hooks/useTheme';

interface Props {
  size?: number | string;
  color?: string; // 保留接口兼容性
  autoContrast?: boolean; // 保留接口兼容性
  darkColor?: string; // 保留接口兼容性
  lightColor?: string; // 保留接口兼容性
}

defineOptions({ name: 'LogoSwift' });

const props = withDefaults(defineProps<Props>(), {
  size: 24,
  autoContrast: true,
  darkColor: '#ffffff',
});

const { menuTheme } = useTheme();

const sizePx = computed(() => (typeof props.size === 'number' ? `${props.size}px` : props.size));

const wrapperStyle = computed(() => ({
  width: sizePx.value,
  height: sizePx.value,
}));
</script>

<style scoped lang="less">
.logo-swift-wrapper {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: visible;
  user-select: none;
}

.logo-image {
  width: 100%;
  height: 100%;
  object-fit: contain;
  transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), filter 0.3s ease;
  will-change: transform, filter;

  // 亮色主题侧边栏：柔和立体浮雕阴影
  &.light {
    filter: drop-shadow(0 2px 4px rgba(15, 23, 42, 0.15)) drop-shadow(0 1px 2px rgba(15, 23, 42, 0.1));
  }

  // 暗色主题侧边栏：多层次液态霓虹光晕
  &.dark {
    filter: drop-shadow(0 0 6px rgba(147, 51, 234, 0.4)) drop-shadow(0 2px 8px rgba(6, 182, 212, 0.25));
  }

  // hover 触发流畅的 3D 浮动与光晕加强效果
  .logo-swift-wrapper:hover & {
    transform: scale(1.15) translateY(-1px) rotate(4deg);
    
    &.light {
      filter: drop-shadow(0 4px 8px rgba(15, 23, 42, 0.22)) drop-shadow(0 2px 4px rgba(15, 23, 42, 0.15));
    }
    
    &.dark {
      filter: drop-shadow(0 0 10px rgba(147, 51, 234, 0.65)) drop-shadow(0 4px 12px rgba(6, 182, 212, 0.5));
    }
  }
}
</style>
