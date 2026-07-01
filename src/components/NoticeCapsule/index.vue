<script setup lang="ts">
import { CloudDownloadOutlined, LoadingOutlined } from '@ant-design/icons-vue';
import { useNoticeCarousel } from './hooks/useNoticeCarousel';
import './style.less';

defineOptions({ name: 'NoticeCapsule' });

const {
  currentIndex,
  isHovered,
  containerRef,
  textRef,
  isOverflow,
  downloadLoading,
  currentNotice,
  translateStyle,
  handleDownloadClient,
} = useNoticeCarousel();
</script>

<template>
  <div
    class="notice-capsule"
    @mouseenter="isHovered = true"
    @mouseleave="isHovered = false"
  >
    <!-- 🔮 C4D 三维镜面反射层 -->
    <div class="glass-glare"></div>

    <!-- 🔮 LED 呼吸指示灯 -->
    <span class="capsule-led" :class="`type-${currentNotice.type}`"></span>

    <!-- 左侧通知图标 -->
    <component :is="currentNotice.icon" class="capsule-icon" />

    <!-- 消息文字淡入淡出轮播 + 单向跑马灯视口 -->
    <div ref="containerRef" class="notice-viewport">
      <Transition name="notice-fade">
        <div :key="currentIndex" class="notice-slider-wrapper">
          <div
            class="notice-marquee-content"
            :class="{ 'is-marquee': isOverflow }"
            :style="translateStyle"
          >
            <span ref="textRef" class="notice-text">
              {{ currentNotice.text }}
            </span>
            <span
              v-if="isOverflow"
              class="notice-text duplicate"
              aria-hidden="true"
            >
              {{ currentNotice.text }}
            </span>
          </div>
        </div>
      </Transition>
    </div>

    <!-- 右侧下载动作按钮 -->
    <button
      v-if="currentNotice.actionText"
      class="capsule-btn"
      @click.stop="handleDownloadClient"
      :disabled="downloadLoading"
    >
      <LoadingOutlined v-if="downloadLoading" />
      <CloudDownloadOutlined v-else />
      <span>{{ currentNotice.actionText }}</span>
    </button>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
