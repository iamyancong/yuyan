<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import {
  FLYING_BIRD_COUNT,
  REDUCED_MOTION_VISIBLE_DURATION_MS,
  SPLASH_REMOVE_DELAY_MS,
  SPLASH_VISIBLE_DURATION_MS,
} from './AppSplash/constant';

const emit = defineEmits<{ finished: [] }>();
const visible = ref(true);
let finishTimer: ReturnType<typeof setTimeout> | undefined;
let removeTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 结束开屏动画并在退场动画完成后卸载组件。
 * @returns 无返回值
 */
const finish = (): void => {
  if (!visible.value) return;

  visible.value = false;
  if (finishTimer) clearTimeout(finishTimer);
  removeTimer = setTimeout(() => emit('finished'), SPLASH_REMOVE_DELAY_MS);
};

onMounted(() => {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const visibleDuration = prefersReducedMotion
    ? REDUCED_MOTION_VISIBLE_DURATION_MS
    : SPLASH_VISIBLE_DURATION_MS;

  finishTimer = setTimeout(finish, visibleDuration);
});

onBeforeUnmount(() => {
  if (finishTimer) clearTimeout(finishTimer);
  if (removeTimer) clearTimeout(removeTimer);
});
</script>

<template>
  <Transition name="splash-fade">
    <section v-if="visible" class="swift-splash" aria-label="雨燕平台正在启动">
      <div class="ambient ambient--violet" />
      <div class="ambient ambient--cyan" />
      <div class="star-field" />
      <div class="orbit orbit--one" />
      <div class="orbit orbit--two" />

      <svg class="bird-definitions" aria-hidden="true">
        <defs>
          <linearGradient id="swiftWing" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#f5ffff" />
            <stop offset=".2" stop-color="#91efff" />
            <stop offset=".48" stop-color="#507cf5" />
            <stop offset=".76" stop-color="#8353ef" />
            <stop offset="1" stop-color="#26155f" />
          </linearGradient>
          <linearGradient id="swiftBody" x1="0" y1="0" x2="1" y2=".8">
            <stop offset="0" stop-color="#efffff" />
            <stop offset=".32" stop-color="#68e5f2" />
            <stop offset=".68" stop-color="#4961d8" />
            <stop offset="1" stop-color="#2b185d" />
          </linearGradient>
          <linearGradient id="swiftFeather" x1="0" y1="0" x2="1" y2="1">
            <stop stop-color="#c9fbff" />
            <stop offset=".5" stop-color="#7a83ff" />
            <stop offset="1" stop-color="#bf5df1" />
          </linearGradient>

          <symbol id="swiftIcon" viewBox="0 0 240 180">
            <g transform="translate(8 -36) scale(5.25)">
              <path
                d="M6 30c7-10 17-18 32-20-7 6-12 12-16 18 5 2 11 3 18 2-8 3-14 3-20 2-4 3-10 6-18 6 6-3 10-6 12-8-2-3-4-5-8-8 4 1 7 2 10 3z"
                fill="#07091f"
                fill-opacity=".52"
                transform="translate(0 1.1)"
              />
              <path
                d="M6 30c7-10 17-18 32-20-7 6-12 12-16 18 5 2 11 3 18 2-8 3-14 3-20 2-4 3-10 6-18 6 6-3 10-6 12-8-2-3-4-5-8-8 4 1 7 2 10 3z"
                fill="url(#swiftWing)"
                stroke="#d9fdff"
                stroke-opacity=".78"
                stroke-width=".34"
              />
              <path
                d="M8 31c6-5 14-10 22-13-5 5-9 10-11 14 3 1 7 2 12 2-8 2-14 2-20 1z"
                fill="url(#swiftFeather)"
                fill-opacity=".68"
              />
              <path
                d="M6 30c4-2 7-4 10-5l6 3c5 2 11 3 18 2-8 3-14 3-20 2-4 3-10 6-18 6 6-3 10-6 12-8-2-3-4-5-8-8 4 1 7 2 10 3z"
                fill="url(#swiftBody)"
                fill-opacity=".74"
              />
              <path
                d="M9 29c8-8 17-14 27-17M13 33c6-5 12-9 19-12"
                fill="none"
                stroke="#ffffff"
                stroke-linecap="round"
                stroke-opacity=".42"
                stroke-width=".3"
              />
            </g>
          </symbol>
        </defs>
      </svg>

      <div class="flight-layer" aria-hidden="true">
        <div
          v-for="bird in FLYING_BIRD_COUNT"
          :key="bird"
          class="flying-bird"
          :class="`flying-bird--${bird}`"
        >
          <svg viewBox="0 0 240 180"><use href="#swiftIcon" /></svg>
          <span class="speed-line" />
        </div>
        <div class="flying-bird flying-bird--hero">
          <svg viewBox="0 0 240 180"><use href="#swiftIcon" /></svg>
          <span class="speed-line" />
        </div>
      </div>

      <div class="brand-stage">
        <div class="icon-shell">
          <div class="icon-surface">
            <svg viewBox="0 0 240 180" aria-hidden="true"><use href="#swiftIcon" /></svg>
          </div>
        </div>
        <div class="brand-copy">
          <p class="eyebrow">APODIDAE · BORN FOR SPEED</p>
          <h1>SWIFT</h1>
          <div class="platform"><span />PLATFORM<span /></div>
          <p class="tagline">MOVE FAST. BUILD FREELY.</p>
        </div>
      </div>

      <button class="skip-button" type="button" aria-label="跳过开屏动画" @click="finish">
        SKIP <span />
      </button>
    </section>
  </Transition>
</template>

<style scoped lang="less">
@import './AppSplash/style.less';
</style>
