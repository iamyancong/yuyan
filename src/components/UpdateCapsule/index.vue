<script setup lang="ts">
import { computed } from 'vue';
import { PauseCircleOutlined } from '@ant-design/icons-vue';
import { useAppUpdate } from './hooks/useAppUpdate';
import { STATUS_CONFIG_MAP } from './constant';
import './style.less';

defineOptions({ name: 'UpdateCapsule' });

const {
  hasUpdate,
  updateState,
  updatePercent,
  handleCapsuleClick,
  pauseUpdateDownload,
} = useAppUpdate();

/** 当前状态对应的配置 */
const config = computed(() => STATUS_CONFIG_MAP[updateState.value.status]);

/** 将字节速度格式化为易读文本。 */
const formattedSpeed = computed(() => {
  const bytes = updateState.value.bytesPerSecond;
  if (!bytes) return '正在连接';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB/s`;
});

/** 下载进度辅助说明。 */
const downloadDetail = computed(() => {
  const remaining = updateState.value.remainingSeconds;
  const retry = updateState.value.retryCount;
  const parts = [formattedSpeed.value];
  if (remaining !== null) parts.push(`约 ${remaining} 秒`);
  if (retry > 0) parts.push(`重试 ${retry}/${3}`);
  return parts.join(' · ');
});
</script>

<template>
  <div
    v-if="hasUpdate"
    class="update-capsule"
    :class="config.className"
    @click="handleCapsuleClick"
  >
    <!-- 🔮 3D 玻璃反射光泽层 -->
    <div class="glass-glare"></div>

    <!-- 🔮 3D LED 物理状态指示灯 -->
    <span class="capsule-led"></span>

    <!-- 左侧图标 -->
    <component :is="config.icon" class="capsule-icon" />

    <!-- 进度数字（下载中） -->
    <template v-if="updateState.status === 'downloading'">
      <span v-if="updatePercent > 0 && updatePercent < 100" class="progress-text">
        {{ updatePercent }}% · {{ downloadDetail }}
      </span>
      <span v-else class="capsule-label">{{ config.label }}</span>
      <div class="progress-bar-bg" :style="{ width: `${updatePercent}%` }"></div>
      <a-tooltip title="暂停下载，稍后可从断点继续">
        <span class="pause-download" role="button" tabindex="0" @click.stop="pauseUpdateDownload">
          <PauseCircleOutlined />
        </span>
      </a-tooltip>
    </template>

    <!-- 其他状态文案 -->
    <span v-else class="capsule-label">{{ config.label }}</span>
  </div>
</template>
