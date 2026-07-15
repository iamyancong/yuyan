<script setup lang="ts">
import { computed, ref } from 'vue';
import { useAppUpdate } from './hooks/useAppUpdate';
import { STATUS_CONFIG_MAP } from './constant';

defineOptions({ name: 'UpdateCapsule' });

const {
  hasUpdate,
  updateState,
  latestVersion,
  updateLogs,
  handleCapsuleClick,
} = useAppUpdate();

const popoverOpen = ref(false);

/** 当前状态对应的配置 */
const config = computed(() => STATUS_CONFIG_MAP[updateState.value.status]);

/** 胶囊只表达用户当前可执行的安装动作。 */
const capsuleLabel = computed(() => {
  if (updateState.value.status === 'completed' && latestVersion.value) {
    return `v${latestVersion.value} 已就绪，点击安装`;
  }
  return config.value.label;
});

/** 支持键盘触发安装操作。 */
const handleKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  popoverOpen.value = !popoverOpen.value;
};

/** 用户在查看更新说明后确认安装。 */
const confirmInstall = () => {
  popoverOpen.value = false;
  handleCapsuleClick();
};
</script>

<template>
  <a-popover v-if="hasUpdate" v-model:open="popoverOpen" trigger="click" placement="bottomLeft">
    <template #content>
      <div class="update-ready-panel">
        <div class="update-ready-title">新版本 v{{ latestVersion }} 已准备完成</div>
        <div class="update-ready-hint">安装程序启动后，雨燕将退出以完成升级。</div>
        <div class="update-ready-logs">{{ updateLogs }}</div>
        <div class="update-ready-actions">
          <a-button size="small" @click="popoverOpen = false">稍后</a-button>
          <a-button type="primary" size="small" @click="confirmInstall">立即安装</a-button>
        </div>
      </div>
    </template>

    <div
      class="update-capsule"
      :class="config.className"
      role="button"
      tabindex="0"
      :aria-label="capsuleLabel"
      :aria-expanded="popoverOpen"
      @keydown="handleKeydown"
    >
      <!-- 🔮 3D 玻璃反射光泽层 -->
      <div class="glass-glare"></div>

      <!-- 🔮 3D LED 物理状态指示灯 -->
      <span class="capsule-led"></span>

      <!-- 左侧图标 -->
      <component :is="config.icon" class="capsule-icon" />

      <span class="capsule-label">{{ capsuleLabel }}</span>
    </div>
  </a-popover>
</template>

<style scoped lang="less">
@import './style.less';
</style>
