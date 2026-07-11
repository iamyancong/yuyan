<script setup lang="ts">
import { computed } from 'vue';
import { 
  RightOutlined, 
  CopyOutlined, 
  CloseOutlined,
  LoadingOutlined
} from '@ant-design/icons-vue';
import { ABOUT_CONFIG } from './constant';
import { useAboutInfo } from './hooks/useAboutInfo';

defineOptions({ name: 'AboutModal' });

const props = defineProps<{
  /** 弹窗是否可见 */
  open: boolean;
}>();

const emit = defineEmits<{
  /** 更新弹窗可见性 */
  (e: 'update:open', val: boolean): void;
}>();

// 双向绑定计算属性
const visible = computed({
  get: () => props.open,
  set: (val) => emit('update:open', val)
});



// 引入 Composable 业务逻辑
const {
  systemInfo,
  infoLoading,
  diagnosticExpanded,
  toggleDiagnostic,
  handleCopyInfo
} = useAboutInfo();

/** 关闭弹窗 */
const handleClose = () => {
  visible.value = false;
};
</script>

<template>
  <a-modal
    v-model:open="visible"
    :footer="null"
    :width="380"
    :destroyOnClose="true"
    :maskClosable="false"
    centered
    wrapClassName="yuyan-about-modal-wrap"
  >
    <div class="about-container">
      <!-- 3D C4D 风格 Logo 容器 -->
      <div class="about-logo-wrapper">
        <img src="/yuyan-swift-dark.svg" alt="Yuyan Logo" class="about-logo-img" />
      </div>

      <!-- 软件基本信息 -->
      <div class="about-title">{{ ABOUT_CONFIG.appName }}</div>
      <div class="about-desc">Version {{ systemInfo.appVersion }}</div>

      <!-- 诊断信息展开切换器 -->
      <div class="diagnostic-trigger-wrapper">
        <div class="diagnostic-btn" @click="toggleDiagnostic">
          <span>环境诊断数据</span>
          <RightOutlined class="arrow-icon" :class="{ 'is-expanded': diagnosticExpanded }" />
        </div>
      </div>

      <!-- 可折叠诊断数据面板 -->
      <div class="diagnostic-panel" :class="{ 'is-expanded': diagnosticExpanded }">
        <div class="diagnostic-code-box">
          <div v-if="infoLoading" style="text-align: center; padding: 12px 0;">
            <LoadingOutlined style="font-size: 16px; color: #7c3aed;" />
            <span style="margin-left: 8px; color: #9ca3af;">读取诊断中...</span>
          </div>
          <template v-else>
            <div class="info-row">
              <span class="label">客户端版本</span>
              <span class="value">v{{ systemInfo.appVersion }}</span>
            </div>
            <!-- <div class="info-row">
              <span class="label">Tauri 核心</span>
              <span class="value">{{ systemInfo.tauriVersion }}</span>
            </div> -->
            <!-- <div class="info-row">
              <span class="label">渲染引擎</span>
              <span class="value">{{ systemInfo.renderEngine }}</span>
            </div> -->
            <div class="info-row">
              <span class="label">操作系统</span>
              <span class="value">{{ systemInfo.osInfo }}</span>
            </div>
          </template>
        </div>
      </div>

      <!-- 版权声明 -->
      <div class="about-copyright">{{ ABOUT_CONFIG.copyright }}</div>

      <!-- 底部操作按钮栏 -->
      <div class="about-actions">
        <a-button class="btn-copy" @click="handleCopyInfo">
          <template #icon>
            <CopyOutlined />
          </template>
          复制信息
        </a-button>
        <a-button type="primary" class="btn-close" @click="handleClose">
          <!-- <template #icon>
            <CloseOutlined />
          </template> -->
          确定
        </a-button>
      </div>
    </div>
  </a-modal>
</template>

<style scoped lang="less">
@import './style.less';
</style>
