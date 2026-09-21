<script setup lang="ts">
import { computed } from 'vue';
import { CloseOutlined, ExportOutlined } from '@ant-design/icons-vue';
import C4DBadge from './components/C4DBadge.vue';
import { useFloatingNotification } from './hooks/useFloatingNotification';

defineOptions({ name: 'FloatingNotification' });

const {
  notificationData,
  isVisible,
  isClosing,
  isProgressMode,
  progress,
  dismiss,
  handleActionClick,
  handleOpenSite,
  handleCardClick,
  handlePointerEnter,
  handlePointerLeave,
  handleFocusIn,
  handleFocusOut,
} = useFloatingNotification();

const isSuccess = computed(() => notificationData.value.status === 'success');
const destinationText = computed(() => notificationData.value.targetName || notificationData.value.envName || '目标主机');
const tagLabel = computed(() => {
  if (notificationData.value.envName) return notificationData.value.envName;
  if (isProgressMode.value) return '处理中';
  return isSuccess.value ? '已就绪' : '异常';
});
const displayDescription = computed(() => {
  const d = notificationData.value;
  if (isProgressMode.value) return d.stage || d.projectName || '正在处理中…';
  if (d.description) return d.description;
  if (isSuccess.value) {
    if (d.stage && !d.visitUrl) return `${d.projectName || ''} ${d.stage}`.trim();
    return `${d.projectName} 已成功发布到「${destinationText.value}」`;
  }
  return `${d.projectName || ''} ${d.stage ? `在「${d.stage}」` : ''}失败：${d.errorMessage || '未知异常'}`;
});
const notificationAriaLabel = computed(() => `${notificationData.value.title}，${displayDescription.value}`);
const notificationKey = computed(() => {
  const d = notificationData.value;
  return [d.timestamp, d.status, d.title, d.projectName, d.targetName].filter(Boolean).join('|');
});
</script>

<template>
  <div class="floating-notification-wrapper">
    <div
      v-if="isVisible"
      :key="notificationKey"
      class="floating-glass-card"
      :class="[`is-${notificationData.status}`, { 'floating-glass-card--closing': isClosing }]"
      :role="notificationData.status === 'error' ? 'alert' : 'status'"
      aria-live="polite"
      :aria-label="notificationAriaLabel"
      aria-keyshortcuts="Escape"
      tabindex="0"
      @click="handleCardClick"
      @keydown.enter="handleCardClick"
      @keydown.space.prevent="handleCardClick"
      @pointerenter="handlePointerEnter"
      @pointerleave="handlePointerLeave"
      @focusin="handleFocusIn"
      @focusout="handleFocusOut"
    >
      <div class="floating-glass-card__shine" />
      <button class="floating-glass-card__close-btn" type="button" aria-label="关闭通知" @click.stop="dismiss">
        <CloseOutlined />
      </button>

      <div class="floating-glass-card__content">
        <C4DBadge :status="notificationData.status" />

        <div class="floating-glass-card__body">
          <div class="floating-glass-card__header">
            <span class="floating-glass-card__title">{{ notificationData.title }}</span>
            <span class="floating-glass-card__tag" :class="`is-${notificationData.status}`">{{ tagLabel }}</span>
          </div>

          <div class="floating-glass-card__desc" :title="displayDescription">
            <span>{{ displayDescription }}</span>
          </div>

          <div class="floating-glass-card__meta">
            <span class="floating-glass-card__time-badge">
              <template v-if="isProgressMode">
                <span>{{ progress !== null ? `进度 ${Math.round(progress)}%` : '传输中' }}</span>
              </template>
              <template v-else>
                <span>刚刚</span>
                <span v-if="notificationData.duration">· 耗时 {{ notificationData.duration }}</span>
              </template>
            </span>
          </div>
        </div>

        <div class="floating-glass-card__actions">
          <template v-if="notificationData.actions?.length">
            <button
              v-for="act in notificationData.actions"
              :key="act.id"
              class="floating-glass-card__btn-action"
              :class="[{ 'is-primary': act.primary, 'is-danger': act.danger }]"
              type="button"
              @click.stop="handleActionClick(act)"
            >{{ act.text }}</button>
          </template>
          <template v-else-if="isSuccess && notificationData.visitUrl">
            <button class="floating-glass-card__btn-visit" type="button" @click.stop="handleOpenSite">
              <span>打开站点</span>
              <ExportOutlined />
            </button>
          </template>
          <template v-else>
            <button class="floating-glass-card__btn-details" type="button" @click.stop="handleCardClick">详情</button>
          </template>
        </div>
      </div>

      <div class="floating-glass-card__progress-track">
        <div
          class="floating-glass-card__progress-bar"
          :class="`is-${notificationData.status}`"
          :style="{ width: `${progress}%` }"
          role="progressbar"
          aria-label="进度"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="Math.round(progress)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
