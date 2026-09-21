<script setup lang="ts">
import {
  CheckOutlined,
  CloudDownloadOutlined,
  ExclamationOutlined,
  InfoOutlined,
} from '@ant-design/icons-vue';
import type { DesktopFloatingTaskStatus } from '../constant';

defineProps<{
  /** 任务状态 */
  status: DesktopFloatingTaskStatus;
}>();
</script>

<template>
  <div
    class="c4d-badge-box"
    :class="`is-${status}`"
    role="img"
    :aria-label="`状态：${status}`"
  >
    <!-- 直接复用雨燕 App 图标，状态由右下角角标表达。 -->
    <img class="c4d-badge-app-icon" src="/yuyan-notification-icon.png" alt="" />
    <span class="c4d-badge-status" aria-hidden="true">
      <CheckOutlined v-if="status === 'success'" />
      <CloudDownloadOutlined v-else-if="status === 'downloading'" />
      <InfoOutlined v-else-if="status === 'info'" />
      <ExclamationOutlined v-else />
    </span>
  </div>
</template>

<style scoped lang="less">
.c4d-badge-box {
  position: relative;
  flex-shrink: 0;
  width: 46px;
  height: 46px;
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.88);
  border: 1.5px solid rgba(255, 255, 255, 0.28);
  box-shadow: inset 0 1px 2px rgba(255, 255, 255, 0.34), inset 0 -1px 2px rgba(0, 0, 0, 0.48);
  animation: swallow-badge-in 0.55s cubic-bezier(0.34, 1.56, 0.64, 1) both;

  &::after {
    position: absolute;
    inset: -20% 46% -20% -46%;
    content: '';
    background: linear-gradient(105deg, transparent 35%, rgba(255, 255, 255, 0.42), transparent 65%);
    transform: translateX(-120%);
    animation: swallow-badge-sheen 0.8s 0.25s ease-out both;
    pointer-events: none;
  }

  &.is-error {
    border-color: rgba(248, 113, 113, 0.62);
  }

  &.is-downloading {
    border-color: rgba(56, 189, 248, 0.62);
  }

  &.is-warning {
    border-color: rgba(251, 191, 36, 0.62);
  }
}

.c4d-badge-app-icon {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 12px;
  object-fit: cover;
  animation: swallow-mark-in 0.6s 0.05s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}

.c4d-badge-status {
  position: absolute;
  right: -1px;
  bottom: -1px;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 17px;
  border: 2px solid #182238;
  border-radius: 50%;
  color: #052e1a;
  background: #6ee7a2;
  box-shadow: 0 2px 5px rgba(0, 0, 0, 0.3);
  font-size: 9px;
  animation: swallow-status-in 0.32s 0.28s cubic-bezier(0.34, 1.56, 0.64, 1) both;

  .c4d-badge-box.is-error & {
    color: #450a0a;
    background: #fda4af;
  }

  .c4d-badge-box.is-downloading & {
    color: #0c4a6e;
    background: #38bdf8;
  }

  .c4d-badge-box.is-warning & {
    color: #713f12;
    background: #fde047;
  }
}

@keyframes swallow-badge-in {
  from {
    opacity: 0;
    transform: scale(0.84) rotate(-4deg);
  }
  to {
    opacity: 1;
    transform: scale(1) rotate(0);
  }
}

@keyframes swallow-mark-in {
  from {
    opacity: 0;
    transform: translateY(3px) scale(0.86);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes swallow-status-in {
  from {
    opacity: 0;
    transform: scale(0.5);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes swallow-badge-sheen {
  to {
    transform: translateX(260%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .c4d-badge-box,
  .c4d-badge-box::after,
  .c4d-badge-app-icon,
  .c4d-badge-status {
    animation: none;
  }
}
</style>
