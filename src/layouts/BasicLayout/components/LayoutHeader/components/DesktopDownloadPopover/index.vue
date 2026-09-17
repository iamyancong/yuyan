<script setup lang="ts">
import {
  AppleOutlined, WindowsOutlined, DownOutlined,
  RightOutlined, ExportOutlined, DownloadOutlined,
  SafetyCertificateOutlined, ThunderboltOutlined,
} from '@ant-design/icons-vue';
import DesktopC4dIcon from './components/DesktopC4dIcon.vue';
import { formatFileSize } from './constant';
import { useDesktopDownload } from './hooks/useDesktopDownload';
import { useDownloadGuide } from './hooks/useDownloadGuide';

defineOptions({ name: 'DesktopDownloadPopover' });

const {
  popoverVisible, downloading, currentPlatform,
  currentAssetMeta, latestVersion, showOtherPlatforms,
  otherPlatforms, triggerDownload, selectPlatform,
  toggleOtherPlatforms, openReleaseNotes,
} = useDesktopDownload();

const { guideVisible, dismissGuide } = useDownloadGuide();

/** 处理触发器点击，触发时静默弱引导小红点 */
const handleTriggerClick = () => {
  dismissGuide();
};
</script>

<template>
  <div class="desktop-download-container">
    <a-popover
      v-model:open="popoverVisible"
      trigger="click"
      placement="bottomRight"
      overlayClassName="desktop-download-popover"
      :arrow="{ pointAtCenter: true }"
    >
      <template #content>
        <div class="download-card">
          <!-- 🔮 头部品牌与卖点 -->
          <div class="card-header">
            <div class="brand-row">
              <div class="brand-title-wrap">
                <div class="brand-icon-box">
                  <DesktopC4dIcon :size="19" />
                </div>
                <span class="brand-title">雨燕桌面端</span>
              </div>
              <span class="version-badge">v{{ latestVersion }}</span>
            </div>

            <ul class="features-list">
              <li class="feature-item">
                <SafetyCertificateOutlined class="feature-icon" />
                <span>免密长效会话，告别反复输入令牌</span>
              </li>
              <li class="feature-item">
                <ThunderboltOutlined class="feature-icon" />
                <span>原生环境支持，构建部署与运维一体</span>
              </li>
            </ul>
          </div>

          <!-- 🔮 主 CTA 按钮（当前系统智能推荐） -->
          <div class="main-cta-section">
            <button
              type="button"
              class="btn-main-cta"
              :disabled="downloading"
              @click="triggerDownload()"
            >
              <AppleOutlined v-if="currentPlatform.icon === 'apple'" class="cta-icon" />
              <WindowsOutlined v-else class="cta-icon" />
              <span class="cta-label">{{ downloading ? '准备下载中...' : currentPlatform.ctaLabel }}</span>
              <span v-if="currentAssetMeta?.size" class="cta-size">
                {{ formatFileSize(currentAssetMeta.size) }}
              </span>
            </button>
          </div>

          <!-- 🔮 其他平台与架构展开 -->
          <div class="other-platforms-section">
            <div class="toggle-bar" @click="toggleOtherPlatforms">
              <span>其他平台与架构</span>
              <component :is="showOtherPlatforms ? DownOutlined : RightOutlined" class="toggle-icon" />
            </div>

            <div v-if="showOtherPlatforms" class="platform-list">
              <div
                v-for="platform in otherPlatforms"
                :key="platform.key"
                class="platform-item"
                @click="selectPlatform(platform)"
              >
                <div class="platform-item-left">
                  <AppleOutlined v-if="platform.icon === 'apple'" class="platform-icon" />
                  <WindowsOutlined v-else class="platform-icon" />
                  <span class="platform-label">{{ platform.title }}</span>
                </div>
                <div class="platform-item-right">
                  <span class="platform-ext">{{ platform.ext }}</span>
                  <DownloadOutlined class="download-glyph" />
                </div>
              </div>
            </div>
          </div>

          <!-- 🔮 底部来源与更新说明 -->
          <div class="card-footer">
            <span class="footer-source">
              <span class="status-pulse-dot" />
              官方发布 · 内网加速
            </span>
            <a class="footer-link" @click="openReleaseNotes">
              更新说明
              <ExportOutlined style="font-size: 10px" />
            </a>
          </div>
        </div>
      </template>

      <!-- 🔮 顶栏 C4D 电脑立体图标触发器 -->
      <a-badge :dot="guideVisible" :offset="[-2, 4]">
        <a-tooltip
          :title="popoverVisible ? '' : (guideVisible ? '推荐下载桌面端，免密长效会话' : '雨燕桌面端')"
          overlayClassName="header-tooltip"
        >
          <a-button
            type="text"
            class="header-action-btn btn-desktop-download"
            :class="{ 'has-guide': guideVisible }"
            @click="handleTriggerClick"
          >
            <template #icon>
              <DesktopC4dIcon :size="21" />
            </template>
          </a-button>
        </a-tooltip>
      </a-badge>
    </a-popover>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
