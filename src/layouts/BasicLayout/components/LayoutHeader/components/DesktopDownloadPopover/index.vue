<script setup lang="ts">
import {
  AppleOutlined, WindowsOutlined, DownloadOutlined,
  LoadingOutlined, ExportOutlined,
  SafetyCertificateOutlined, ThunderboltOutlined,
} from '@ant-design/icons-vue';
import DesktopC4dIcon from './components/DesktopC4dIcon.vue';
import MacQuarantineGuide from './components/MacQuarantineGuide.vue';
import { formatFileSize } from './constant';
import { useDesktopDownload } from './hooks/useDesktopDownload';
import { useDownloadGuide } from './hooks/useDownloadGuide';

defineOptions({ name: 'DesktopDownloadPopover' });

const {
  popoverVisible, downloadingKey, currentPlatform,
  currentAssetMeta, latestVersion, assetsMap,
  otherPlatforms, triggerDownload, openReleaseNotes,
} = useDesktopDownload();

const { guideVisible, dismissGuide } = useDownloadGuide();
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
                <div class="brand-icon-box"><DesktopC4dIcon :size="19" /></div>
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
                <span>原生系统环境，构建部署与运维一体</span>
              </li>
            </ul>
          </div>

          <!-- 🔮 主 CTA 按钮（当前系统推荐，1-Click 直达下载） -->
          <div class="main-cta-section">
            <button
              type="button"
              class="btn-main-cta"
              :disabled="Boolean(downloadingKey)"
              @click="triggerDownload()"
            >
              <LoadingOutlined v-if="downloadingKey === currentPlatform.key" class="cta-icon spin" />
              <AppleOutlined v-else-if="currentPlatform.icon === 'apple'" class="cta-icon" />
              <WindowsOutlined v-else class="cta-icon" />
              <span class="cta-label">{{ downloadingKey === currentPlatform.key ? '准备下载中...' : currentPlatform.ctaLabel }}</span>
              <span v-if="currentAssetMeta?.size" class="cta-size">{{ formatFileSize(currentAssetMeta.size) }}</span>
            </button>
          </div>

          <!-- 🔮 另外两种平台免折叠平铺展示（1-Click 直达下载） -->
          <div class="other-platforms-section">
            <div class="section-sub-title">其他系统 / 架构免切换直达：</div>
            <div class="platform-list">
              <div
                v-for="platform in otherPlatforms"
                :key="platform.key"
                class="platform-item"
                @click="triggerDownload(platform)"
              >
                <div class="platform-item-left">
                  <AppleOutlined v-if="platform.icon === 'apple'" class="platform-icon" />
                  <WindowsOutlined v-else class="platform-icon" />
                  <div class="platform-info-text">
                    <span class="platform-label">{{ platform.title }}</span>
                    <span class="platform-sub-desc">{{ platform.desc }}</span>
                  </div>
                </div>
                <div class="platform-item-right">
                  <span v-if="assetsMap[platform.key]?.size" class="platform-size-tag">
                    {{ formatFileSize(assetsMap[platform.key]?.size) }}
                  </span>
                  <button type="button" class="btn-quick-download" :disabled="Boolean(downloadingKey)" :title="`直接下载 ${platform.title}`">
                    <LoadingOutlined v-if="downloadingKey === platform.key" class="spin" />
                    <DownloadOutlined v-else />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- 🔮 macOS Gatekeeper 首次隔离解除终端指引 -->
          <MacQuarantineGuide />

          <!-- 🔮 底部来源与更新说明 -->
          <div class="card-footer">
            <span class="footer-source"><span class="status-pulse-dot" />官方发布 · 内网加速</span>
            <a class="footer-link" @click="openReleaseNotes">
              更新说明<ExportOutlined style="font-size: 10px" />
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
            @click="dismissGuide"
          >
            <template #icon><DesktopC4dIcon :size="21" /></template>
          </a-button>
        </a-tooltip>
      </a-badge>
    </a-popover>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
