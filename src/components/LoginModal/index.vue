<script setup lang="ts">
import { computed } from 'vue';
import { KeyOutlined, GlobalOutlined, QuestionCircleOutlined } from '@ant-design/icons-vue';
import LogoSwift from '@/components/LogoSwift.vue';
import DesktopC4dIcon from '@/layouts/BasicLayout/components/LayoutHeader/components/DesktopDownloadPopover/components/DesktopC4dIcon.vue';
import { isTauri } from '@/utils/env';
import { useDesktopDownload } from '@/layouts/BasicLayout/components/LayoutHeader/components/DesktopDownloadPopover/hooks/useDesktopDownload';
import LoginIllustration from './components/LoginIllustration.vue';
import {
  type LoginModalProps,
  type LoginModalEmits,
  TOKEN_HELP_ALERT,
  REMEMBER_ME_SECURITY_TIP,
} from './constant';
import { useLoginForm } from './hooks/useLoginForm';

defineOptions({ name: 'LoginModal' });

const props = defineProps<LoginModalProps>();
const emit = defineEmits<LoginModalEmits>();

const visible = computed({
  get: () => props.visible,
  set: (val: boolean) => emit('update:visible', val),
});

const { currentPlatform, triggerDownload } = useDesktopDownload();
const handleDownloadDesktop = () => {
  triggerDownload();
};
const { loading, loginForm, handleLogin, handleCancel } = useLoginForm(
  () => emit('login-success'),
  () => { visible.value = false; }
);
</script>

<template>
  <a-modal
    v-model:open="visible"
    :footer="null"
    :width="1200"
    :closable="false"
    :maskClosable="false"
    :centered="true"
    wrapClassName="premium-login-modal1"
    class="premium-login-modal"
    @cancel="handleCancel"
  >
    <div class="modal-content-wrapper">
      <!-- 左侧内容区 -->
      <div class="login-content">
        <header class="brand-header">
          <div class="logo-wrapper"><LogoSwift :size="32" /></div>
          <div class="brand-info">
            <h2 class="brand-name">雨燕平台</h2>
            <p class="brand-desc">GitLab 项目管理</p>
          </div>
        </header>

        <a-form :model="loginForm" layout="vertical" @finish="handleLogin" class="login-form-wrapper">
          <a-form-item label="GitLab 访问令牌" name="token" :rules="[{ required: true, message: '请输入GitLab访问令牌' }]">
            <a-input-password v-model:value="loginForm.token" placeholder="请输入您的 GitLab Personal Access Token" size="large" allow-clear>
              <template #prefix><KeyOutlined /></template>
            </a-input-password>
          </a-form-item>

          <a-form-item label="GitLab 服务器地址" name="host" :rules="[{ required: true, message: '请输入GitLab服务器地址' }]">
            <a-input v-model:value="loginForm.host" placeholder="如: http://gitlab.example.com" size="large" allow-clear>
              <template #prefix><GlobalOutlined /></template>
            </a-input>
          </a-form-item>

          <!-- 网页端跨会话记住我选项（30天免重登） -->
          <div v-if="!isTauri()" class="login-options-row">
            <a-checkbox v-model:checked="loginForm.rememberMe">记住登录状态 (30天)</a-checkbox>
            <a-tooltip :title="REMEMBER_ME_SECURITY_TIP">
              <QuestionCircleOutlined class="security-tip-icon" />
            </a-tooltip>
          </div>

          <a-form-item>
            <a-button type="primary" html-type="submit" size="large" block :loading="loading" class="submit-btn">
              {{ loading ? '登录中...' : '登 录' }}
            </a-button>
          </a-form-item>
        </a-form>

        <div class="help-section">
          <a-alert :message="TOKEN_HELP_ALERT.message" :description="TOKEN_HELP_ALERT.description" type="info" show-icon :closable="true" />
          <!-- 网页端引导下载桌面端（免密会话体验） -->
          <div v-if="!isTauri()" class="desktop-download-tip">
            <span class="tip-prompt">嫌每次登录反复输入令牌麻烦？</span>
            <a
              class="tip-cta"
              :title="`支持免密登录并自动恢复会话，适用于 ${currentPlatform.title}`"
              @click="handleDownloadDesktop"
            >
              <DesktopC4dIcon :size="16" /> 下载雨燕桌面端 ({{ currentPlatform.title }})
            </a>
          </div>
        </div>
      </div>

      <!-- 右侧内容区 (3D 展台) -->
      <LoginIllustration />
    </div>
  </a-modal>
</template>

<style scoped lang="less">
@import './style.less';
</style>
