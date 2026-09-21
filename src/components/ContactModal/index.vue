<script setup lang="ts">
import { computed } from 'vue';
import {
  CloseOutlined,
  CopyOutlined,
  GlobalOutlined,
  MailOutlined,
  IdcardOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons-vue';
import qrCodeImg from '@/assets/contact/wecom-qrcode.png';
import { useContact } from './hooks/useContact';

defineOptions({ name: 'ContactModal' });

const props = defineProps<{
  /** 弹窗是否可见 */
  open: boolean;
}>();

const emit = defineEmits<{
  /** 更新弹窗可见性 */
  (e: 'update:open', val: boolean): void;
}>();

/** 双向绑定弹窗可见性 */
const visible = computed({
  get: () => props.open,
  set: (val) => emit('update:open', val),
});

const {
  contactInfo,
  isLaunching,
  handleContactViaWeCom,
  handleOpenCardUrl,
  handleCopyEmail,
  handleCopyWorkNo,
} = useContact();

/** 关闭弹窗 */
const handleClose = () => {
  visible.value = false;
};
</script>

<template>
  <a-modal
    v-model:open="visible"
    :footer="null"
    :width="360"
    :destroyOnClose="true"
    :maskClosable="true"
    :closable="false"
    centered
    wrapClassName="yuyan-contact-modal-wrap"
  >
    <div class="contact-container">
      <!-- 关闭图标 -->
      <div class="contact-close-btn" title="关闭" @click="handleClose">
        <CloseOutlined />
      </div>

      <!-- 个人/组织头部 -->
      <div class="contact-header">
        <div class="company-badge">{{ contactInfo.company }}</div>
        <div class="contact-name">
          <span>{{ contactInfo.name }}</span>
        </div>
        <div class="contact-role">{{ contactInfo.role }}</div>
      </div>

      <!-- 二维码白底展示卡片 -->
      <div class="contact-qr-card">
        <img :src="qrCodeImg" alt="企业微信二维码" class="qr-image" />
        <div class="qr-tip">
          <span>微信 / 企业微信扫码联系</span>
        </div>
      </div>

      <!-- 信息条目 -->
      <div class="contact-info-list">
        <!-- 邮箱（主搜索项） -->
        <div class="info-item">
          <span class="item-label">
            <MailOutlined />
            <span>邮箱</span>
          </span>
          <div class="item-value-box">
            <span class="item-value">{{ contactInfo.email }}</span>
            <CopyOutlined class="copy-icon" title="复制邮箱" @click="handleCopyEmail" />
          </div>
        </div>

        <!-- 工号 -->
        <div class="info-item">
          <span class="item-label">
            <IdcardOutlined />
            <span>工号</span>
          </span>
          <div class="item-value-box">
            <span class="item-value">{{ contactInfo.workNo }}</span>
            <CopyOutlined class="copy-icon" title="复制代码工号" @click="handleCopyWorkNo" />
          </div>
        </div>
      </div>

      <!-- 操作按钮区域 -->
      <div class="contact-actions">
        <!-- 核心推荐：直接唤起企业微信 -->
        <a-button
          type="primary"
          block
          class="btn-wecom-direct"
          :loading="isLaunching"
          @click="handleContactViaWeCom"
        >
          <template #icon>
            <ThunderboltOutlined />
          </template>
          在电脑企微中联系我 (复制邮箱)
        </a-button>

        <!-- 辅助操作行 -->
        <div class="secondary-action-row">
          <a-button class="btn-secondary" @click="handleOpenCardUrl">
            <template #icon>
              <GlobalOutlined />
            </template>
            网页名片
          </a-button>

          <a-button class="btn-secondary" @click="handleCopyEmail">
            <template #icon>
              <CopyOutlined />
            </template>
            复制邮箱
          </a-button>
        </div>
      </div>
    </div>
  </a-modal>
</template>

<style scoped lang="less">
@import './style.less';
</style>
