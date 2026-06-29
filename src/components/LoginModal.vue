<script setup lang="ts">
import { ref, reactive, computed } from 'vue';
import { message } from 'ant-design-vue';
import { KeyOutlined, GlobalOutlined } from '@ant-design/icons-vue';
import LogoSwift from '@/components/LogoSwift.vue';
import { useAuth } from '@/composables/useAuth';

defineOptions({ name: 'LoginModal' });

interface LoginForm {
  token: string;
  host: string;
}

interface Props {
  visible: boolean;
}

interface Emits {
  (e: 'update:visible', value: boolean): void;
  (e: 'login-success'): void;
}

const props = defineProps<Props>();
const emit = defineEmits<Emits>();

const loading = ref(false);
const loginForm = reactive<LoginForm>({
  token: '',
  host: import.meta.env.VITE_GITLAB_HOST || '',
});

const { login: authLogin } = useAuth();

const visible = computed({
  get: () => props.visible,
  set: (value) => emit('update:visible', value),
});

const handleLogin = async () => {
  if (!loginForm.token.trim() || !loginForm.host.trim()) {
    message.error('请输入完整的登录信息');
    return;
  }

  loading.value = true;

  try {
    const success = await authLogin(loginForm.token.trim(), loginForm.host.trim());

    if (success) {
      message.success('登录成功！');
      visible.value = false;
      emit('login-success');
    } else {
      message.error('登录失败，请检查令牌和服务器地址');
    }
  } catch (error: any) {
    console.error('登录失败:', error);
    message.error(error?.response?.data?.message || error?.message || '登录失败');
  } finally {
    loading.value = false;
  }
};

const handleCancel = () => {
  if (!loading.value) {
    visible.value = false;
  }
};
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
          <div class="logo-wrapper">
            <LogoSwift :size="32" />
          </div>
          <div class="brand-info">
            <h2 class="brand-name">雨燕平台</h2>
            <p class="brand-desc">GitLab 项目管理</p>
          </div>
        </header>

        <a-form :model="loginForm" layout="vertical" @finish="handleLogin" class="login-form-wrapper">
          <a-form-item label="GitLab 访问令牌" name="token" :rules="[{ required: true, message: '请输入GitLab访问令牌' }]">
            <a-input-password v-model:value="loginForm.token" placeholder="请输入您的 GitLab Personal Access Token" size="large" allow-clear>
              <template #prefix>
                <KeyOutlined />
              </template>
            </a-input-password>
          </a-form-item>

          <a-form-item label="GitLab 服务器地址" name="host" :rules="[{ required: true, message: '请输入GitLab服务器地址' }]">
            <a-input v-model:value="loginForm.host" placeholder="如: http://gitlab.example.com" size="large" allow-clear>
              <template #prefix>
                <GlobalOutlined />
              </template>
            </a-input>
          </a-form-item>

          <a-form-item>
            <a-button type="primary" html-type="submit" size="large" block :loading="loading" class="submit-btn">
              {{ loading ? '登录中...' : '登 录' }}
            </a-button>
          </a-form-item>
        </a-form>

        <div class="help-section">
          <a-alert
            message="获取访问令牌"
            description="登录GitLab账户 → 用户设置 → 访问令牌 → 创建新令牌，选择 api、read_repository、write_repository 权限"
            type="info"
            show-icon
            :closable="true"
          />
        </div>
      </div>

      <!-- 右侧内容区 -->
      <div class="illustration-content">
        <!-- 背景光效 -->
        <div class="glow-effect glow-top"></div>
        <div class="glow-effect glow-bottom"></div>
        <div class="glow-effect glow-center"></div>

        <!-- 3D建筑群落 -->
        <div class="building-complex">
          <!-- 主要建筑 -->
          <div class="main-building">
            <div class="building-face building-front"></div>
            <div class="building-face building-side"></div>
            <div class="building-face building-top"></div>
            <div class="building-window"></div>
            <div class="building-window window-2"></div>
            <div class="building-window window-3"></div>
          </div>

          <!-- 副建筑 -->
          <div class="sub-building">
            <div class="building-face building-front-sub"></div>
            <div class="building-face building-side-sub"></div>
            <div class="building-face building-top-sub"></div>
          </div>

          <!-- 小建筑 -->
          <div class="small-building">
            <div class="building-face building-front-small"></div>
            <div class="building-face building-side-small"></div>
            <div class="building-face building-top-small"></div>
          </div>
        </div>

        <!-- 3D数据图表 -->
        <div class="chart-container">
          <div class="chart-3d">
            <div class="chart-bar bar-1"></div>
            <div class="chart-bar bar-2"></div>
            <div class="chart-bar bar-3"></div>
            <div class="chart-bar bar-4"></div>
            <div class="chart-base"></div>
          </div>
        </div>

        <!-- 金币堆叠 -->
        <div class="coin-stack">
          <div class="coin coin-1"></div>
          <div class="coin coin-2"></div>
          <div class="coin coin-3"></div>
          <div class="coin coin-4"></div>
          <div class="coin coin-5"></div>
        </div>

        <!-- 3D人物角色 -->
        <div class="character-3d">
          <div class="character-head"></div>
          <div class="character-body"></div>
          <div class="character-shadow"></div>
        </div>

        <!-- 浮动装饰元素 -->
        <div class="floating-elements">
          <div class="float-item triangle"></div>
          <div class="float-item circle"></div>
          <div class="float-item pentagon"></div>
          <div class="float-item star"></div>
        </div>

        <!-- 3D平台基座 -->
        <div class="platform-base">
          <div class="platform-top"></div>
          <div class="platform-side"></div>
          <div class="platform-front"></div>
          <div class="platform-shadow"></div>
        </div>

        <div class="hero-content">
          <span class="hero-tag">WELCOME</span>
          <h1 class="hero-title">YUYAN</h1>
          <p class="hero-subtitle">雨燕 · 更快的应用搭建与交付</p>
        </div>
      </div>
    </div>
  </a-modal>
</template>

<style scoped lang="less">
/* 去掉弹窗四角白边 - 覆盖 ant-modal-content 默认样式 */
:global(.premium-login-modal1 .ant-modal-content) {
  padding: 0 !important;
  background: transparent !important;
  border-radius: 24px !important;
  overflow: hidden !important;
}

:global(.premium-login-modal1 .ant-modal-body) {
  padding: 0 !important;
}

.premium-login-modal {
  :deep(.ant-modal-content) {
    padding: 0 !important;
  }
  :deep(.ant-modal-content) {
    background: transparent;
    box-shadow: none;
    padding: 0 !important;
  }

  :deep(.ant-modal-body) {
    padding: 0 !important;
  }

  :deep(.ant-modal-wrap) {
    overflow: hidden;
  }

  :deep(.ant-modal-mask) {
    background: linear-gradient(180deg, rgba(10, 20, 60, 0.75), rgba(8, 14, 40, 0.85));
    backdrop-filter: blur(10px);
  }
}

.modal-content-wrapper {
  display: flex;
  min-height: 680px;
  border-radius: 24px;
  overflow: hidden;
  box-shadow: 0 32px 96px rgba(0, 0, 0, 0.4), 0 16px 48px rgba(0, 0, 0, 0.3);
  position: relative;
  perspective: 2000px;
  transform-style: preserve-3d;

  /* 统一的背景 - 带有弯曲弧线的分隔效果 */
  &::before {
    content: '';
    position: absolute;
    inset: 0;
    background:
      /* 左侧浅灰色区域 - 新拟态风格背景 */ radial-gradient(
        ellipse 180% 100% at -30% 50%,
        #f5f6f8 0%,
        #f3f4f6 30%,
        rgba(243, 244, 246, 0.9) 38%,
        rgba(243, 244, 246, 0.3) 43%,
        transparent 48%
      ),
      /* 右侧蓝色渐变背景 */ radial-gradient(ellipse 1400px 700px at 68% -12%, rgba(140, 160, 255, 0.35) 0%, transparent 58%),
      radial-gradient(ellipse 800px 800px at 20% 110%, rgba(124, 58, 237, 0.25) 0%, transparent 65%),
      linear-gradient(142deg, #5876eb 0%, #4a63d8 30%, #3d52c6 60%, #2e3f9f 100%);
    z-index: 0;
  }
}

/* 左侧内容区 */
.login-content {
  width: 520px;
  padding: 48px 40px 40px;
  position: relative;
  z-index: 3;
  display: flex;
  flex-direction: column;
}

.brand-header {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-bottom: 36px;
  position: relative;
  z-index: 1;

  .logo-wrapper {
    width: 64px;
    height: 64px;
    border-radius: 20px;
    background: #f5f6f8;
    border: none;
    display: flex;
    align-items: center;
    justify-content: center;
    /* 新拟态凸起效果 */
    box-shadow: -4px -4px 8px rgba(255, 255, 255, 0.9), 4px 4px 8px rgba(0, 0, 0, 0.08);
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);

    &:hover {
      box-shadow: -5px -5px 10px rgba(255, 255, 255, 0.95), 5px 5px 10px rgba(0, 0, 0, 0.1), 0 0 0 3px rgba(88, 118, 235, 0.08);
    }
  }

  .brand-info {
    flex: 1;
  }

  .brand-name {
    margin: 0;
    font-size: 28px;
    font-weight: 800;
    color: var(--text-color);
    letter-spacing: -0.03em;
    line-height: 1.2;
  }

  .brand-desc {
    margin: 6px 0 0;
    color: var(--text-color-secondary);
    font-size: 14px;
    font-weight: 600;
  }
}

.login-form-wrapper {
  margin-bottom: 24px;

  :deep(.ant-form-item) {
    margin-bottom: 22px;
  }

  :deep(.ant-form-item-label > label) {
    font-weight: 700;
    color: var(--text-color);
    font-size: 15px;
    margin-bottom: 8px;
  }

  :deep(.ant-input-affix-wrapper),
  :deep(.ant-input) {
    border-radius: 16px;
    border: none;
    padding: 16px 20px;
    font-size: 15px;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    background: var(--bg-color-elevated);
    /* 新拟态凹陷效果 - 内阴影 + 外阴影 */
    box-shadow: inset 3px 3px 6px rgba(0, 0, 0, 0.08), inset -3px -3px 6px rgba(255, 255, 255, 0.8), 0 1px 2px rgba(0, 0, 0, 0.02);

    &:hover {
      background: var(--bg-color);
      box-shadow: inset 4px 4px 8px rgba(0, 0, 0, 0.1), inset -4px -4px 8px rgba(255, 255, 255, 0.9), 0 2px 4px var(--primary-color-lighter);
    }

    &:focus,
    &.ant-input-affix-wrapper-focused {
      background: var(--bg-color);
      box-shadow: inset 4px 4px 10px var(--primary-color-light), inset -4px -4px 10px rgba(255, 255, 255, 0.95),
        0 0 0 3px var(--primary-color-lighter);
    }
  }

  :deep(.ant-input-prefix) {
    margin-right: 12px;
    color: var(--primary-color);
    font-size: 16px;
  }

  // 优化清除按钮样式 - 融入新拟态风格
  :deep(.ant-input-clear-icon) {
    color: var(--text-color-secondary);
    font-size: 14px;
    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    opacity: 0.6;

    &:hover {
      color: var(--primary-color);
      opacity: 1;
      transform: scale(1.1);
    }
  }

  :deep(.ant-input-suffix) {
    margin-left: 8px;
  }

  :deep(.ant-input) {
    font-size: 15px;
    background: transparent;

    &::placeholder {
      color: var(--text-color-tertiary);
      font-weight: 400;
    }
  }

  .submit-btn {
    height: 56px;
    border-radius: 16px;
    font-size: 17px;
    font-weight: 700;
    background: linear-gradient(135deg, var(--primary-color) 0%, var(--primary-color-hover) 50%, var(--primary-color-active) 100%);
    border: none;
    margin-top: 12px;
    transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
    letter-spacing: 1.2px;
    /* 新拟态凸起效果 + 主题色光晕 */
    box-shadow: -4px -4px 10px var(--primary-color-light), 4px 4px 10px var(--primary-color-light), 0 6px 20px var(--primary-color-light);
    position: relative;
    overflow: hidden;

    /* 按钮光泽效果 */
    &::before {
      content: '';
      position: absolute;
      top: 0;
      left: -100%;
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.25), transparent);
      transition: left 0.6s;
    }

    &:hover {
      background: linear-gradient(135deg, var(--primary-color-hover) 0%, var(--primary-color-active) 50%, var(--primary-color-active) 100%);
      transform: translateY(-2px);
      box-shadow: -5px -5px 12px var(--primary-color-light), 5px 5px 12px var(--primary-color-light), 0 10px 28px var(--primary-color-light);

      &::before {
        left: 100%;
      }
    }

    &:active {
      transform: translateY(0);
      box-shadow: inset 3px 3px 8px var(--primary-color-active), inset -3px -3px 8px var(--primary-color-light);
    }
  }
}

.help-section {
  :deep(.ant-alert) {
    border-radius: 14px;
    background: var(--bg-color-elevated);
    border: none;
    padding: 16px 18px;
    /* 新拟态轻微凹陷效果 */
    box-shadow: inset 2px 2px 4px rgba(0, 0, 0, 0.06), inset -2px -2px 4px rgba(255, 255, 255, 0.7);

    .ant-alert-message {
      color: var(--primary-color);
      font-weight: 700;
      font-size: 14px;
      letter-spacing: 0.02em;
    }

    .ant-alert-description {
      color: var(--text-color);
      font-size: 13px;
      line-height: 1.65;
      margin-top: 6px;
      font-weight: 500;
    }

    .ant-alert-icon {
      color: var(--primary-color);
      font-size: 16px;
    }
  }
}

/* 右侧内容区 */
.illustration-content {
  flex: 1;
  position: relative;
  overflow: hidden;
  perspective: 1000px;
  transform-style: preserve-3d;
  z-index: 1;
}

.glow-effect {
  position: absolute;
  filter: blur(90px);
  opacity: 0.45;
  pointer-events: none;
  border-radius: 50%;
  animation: glow-pulse 8s ease-in-out infinite;
}

@keyframes glow-pulse {
  0%,
  100% {
    opacity: 0.45;
    transform: scale(1);
  }
  50% {
    opacity: 0.6;
    transform: scale(1.05);
  }
}

.glow-top {
  width: 550px;
  height: 550px;
  top: -180px;
  right: -120px;
  background: radial-gradient(circle, rgba(100, 130, 255, 0.65) 0%, rgba(85, 116, 231, 0.35) 40%, transparent 70%);
  animation-delay: 0s;
}

.glow-bottom {
  width: 450px;
  height: 450px;
  bottom: -120px;
  left: -100px;
  background: radial-gradient(circle, rgba(140, 70, 255, 0.55) 0%, rgba(124, 58, 237, 0.3) 40%, transparent 70%);
  animation-delay: 4s;
}

.glow-center {
  width: 600px;
  height: 400px;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: radial-gradient(ellipse, rgba(100, 130, 255, 0.4) 0%, rgba(85, 116, 231, 0.25) 30%, transparent 60%);
  animation-delay: 2s;
}

/* 3D建筑群落 */
.building-complex {
  position: absolute;
  right: 80px;
  bottom: 150px;
  width: 200px;
  height: 180px;
  transform-style: preserve-3d;
  transform: rotateX(15deg) rotateY(-25deg);
  animation: building-float 6s ease-in-out infinite;
}

/* 主建筑 */
.main-building {
  position: absolute;
  width: 80px;
  height: 120px;
  left: 50px;
  bottom: 0;
  transform-style: preserve-3d;

  .building-front {
    position: absolute;
    width: 80px;
    height: 120px;
    background: linear-gradient(180deg, #4a6cf7 0%, #3d52c6 50%, #2e3f9f 100%);
    transform: translateZ(40px);
    box-shadow: inset 0 10px 20px rgba(255, 255, 255, 0.1);
  }

  .building-side {
    position: absolute;
    width: 80px;
    height: 120px;
    background: linear-gradient(180deg, #3d52c6 0%, #2e3f9f 50%, #1f2d72 100%);
    transform: rotateY(90deg) translateZ(40px);
  }

  .building-top {
    position: absolute;
    width: 80px;
    height: 80px;
    background: linear-gradient(45deg, #5574e7 0%, #4a6cf7 50%, #3d52c6 100%);
    transform: rotateX(90deg) translateZ(120px);
    box-shadow: 0 5px 15px rgba(0, 0, 0, 0.3);
  }

  .building-window {
    position: absolute;
    width: 12px;
    height: 20px;
    background: linear-gradient(180deg, #ffd98e 0%, #ffb74d 100%);
    box-shadow: 0 0 10px rgba(255, 183, 77, 0.6), inset 0 2px 4px rgba(255, 255, 255, 0.3);
    transform: translateZ(41px);
    border-radius: 2px;

    &:nth-child(4) {
      left: 15px;
      top: 20px;
    }

    &.window-2 {
      left: 35px;
      top: 20px;
    }

    &.window-3 {
      left: 55px;
      top: 20px;
    }
  }
}

/* 副建筑 */
.sub-building {
  position: absolute;
  width: 60px;
  height: 80px;
  left: 15px;
  bottom: 0;
  transform-style: preserve-3d;

  .building-front-sub {
    position: absolute;
    width: 60px;
    height: 80px;
    background: linear-gradient(180deg, #5574e7 0%, #4a6cf7 50%, #3d52c6 100%);
    transform: translateZ(30px);
    box-shadow: inset 0 8px 16px rgba(255, 255, 255, 0.08);
  }

  .building-side-sub {
    position: absolute;
    width: 60px;
    height: 80px;
    background: linear-gradient(180deg, #4a6cf7 0%, #3d52c6 50%, #2e3f9f 100%);
    transform: rotateY(90deg) translateZ(30px);
  }

  .building-top-sub {
    position: absolute;
    width: 60px;
    height: 60px;
    background: linear-gradient(45deg, #6482f0 0%, #5574e7 50%, #4a6cf7 100%);
    transform: rotateX(90deg) translateZ(80px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
  }
}

/* 小建筑 */
.small-building {
  position: absolute;
  width: 40px;
  height: 60px;
  right: 20px;
  bottom: 0;
  transform-style: preserve-3d;

  .building-front-small {
    position: absolute;
    width: 40px;
    height: 60px;
    background: linear-gradient(180deg, #6482f0 0%, #5574e7 50%, #4a6cf7 100%);
    transform: translateZ(20px);
    box-shadow: inset 0 6px 12px rgba(255, 255, 255, 0.06);
  }

  .building-side-small {
    position: absolute;
    width: 40px;
    height: 60px;
    background: linear-gradient(180deg, #5574e7 0%, #4a6cf7 50%, #3d52c6 100%);
    transform: rotateY(90deg) translateZ(20px);
  }

  .building-top-small {
    position: absolute;
    width: 40px;
    height: 40px;
    background: linear-gradient(45deg, #7591f5 0%, #6482f0 50%, #5574e7 100%);
    transform: rotateX(90deg) translateZ(60px);
    box-shadow: 0 3px 9px rgba(0, 0, 0, 0.2);
  }
}

@keyframes building-float {
  0%,
  100% {
    transform: rotateX(15deg) rotateY(-25deg) translateY(0px);
  }
  50% {
    transform: rotateX(15deg) rotateY(-25deg) translateY(-8px);
  }
}

/* 3D数据图表 */
.chart-container {
  position: absolute;
  left: 60px;
  bottom: 180px;
  width: 120px;
  height: 100px;
  transform-style: preserve-3d;
  transform: rotateX(20deg) rotateY(35deg);
  animation: chart-rotate 8s ease-in-out infinite;
}

.chart-3d {
  position: relative;
  width: 100%;
  height: 100%;
  transform-style: preserve-3d;

  .chart-bar {
    position: absolute;
    width: 20px;
    background: linear-gradient(180deg, #8fb4ff 0%, #6482f0 50%, #5574e7 100%);
    border-radius: 2px 2px 0 0;
    box-shadow: 0 4px 12px rgba(100, 130, 255, 0.4);
    transform-origin: bottom;
    animation: bar-grow 2s ease-out infinite alternate;

    &.bar-1 {
      left: 10px;
      height: 60px;
      animation-delay: 0s;
    }
    &.bar-2 {
      left: 35px;
      height: 45px;
      animation-delay: 0.2s;
    }
    &.bar-3 {
      left: 60px;
      height: 75px;
      animation-delay: 0.4s;
    }
    &.bar-4 {
      left: 85px;
      height: 35px;
      animation-delay: 0.6s;
    }
  }

  .chart-base {
    position: absolute;
    bottom: 0;
    width: 100%;
    height: 8px;
    background: linear-gradient(45deg, #3d52c6 0%, #2e3f9f 100%);
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  }
}

/* 金币堆叠 */
.coin-stack {
  position: absolute;
  left: 50px;
  bottom: 40px;
  width: 50px;
  height: 60px;
  transform-style: preserve-3d;
  animation: coin-float 4s ease-in-out infinite;

  .coin {
    position: absolute;
    width: 40px;
    height: 8px;
    background: linear-gradient(135deg, #ffd98e 0%, #ffb74d 50%, #ff9a3c 100%);
    border-radius: 50%;
    box-shadow: 0 2px 8px rgba(255, 154, 60, 0.4), 0 0 0 2px rgba(255, 183, 77, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.3);
    transform-style: preserve-3d;

    &::before {
      content: '';
      position: absolute;
      inset: 4px;
      background: radial-gradient(circle, rgba(255, 220, 140, 0.8) 0%, transparent 70%);
      border-radius: 50%;
    }

    &.coin-1 {
      bottom: 0px;
      transform: rotateX(75deg);
    }
    &.coin-2 {
      bottom: 6px;
      transform: rotateX(75deg);
    }
    &.coin-3 {
      bottom: 12px;
      transform: rotateX(75deg);
    }
    &.coin-4 {
      bottom: 18px;
      transform: rotateX(75deg);
    }
    &.coin-5 {
      bottom: 24px;
      transform: rotateX(75deg);
    }
  }
}

/* 3D人物角色 */
.character-3d {
  position: absolute;
  right: 200px;
  bottom: 80px;
  width: 30px;
  height: 80px;
  transform-style: preserve-3d;
  animation: character-wave 3s ease-in-out infinite;

  .character-head {
    position: absolute;
    width: 16px;
    height: 16px;
    top: 0;
    left: 7px;
    background: linear-gradient(135deg, #ffd98e 0%, #ffb74d 100%);
    border-radius: 50%;
    box-shadow: 0 2px 6px rgba(255, 154, 60, 0.3);
  }

  .character-body {
    position: absolute;
    width: 20px;
    height: 40px;
    top: 16px;
    left: 5px;
    background: linear-gradient(180deg, #6482f0 0%, #5574e7 100%);
    border-radius: 10px 10px 5px 5px;
    box-shadow: 0 4px 10px rgba(100, 130, 255, 0.3);
  }

  .character-shadow {
    position: absolute;
    width: 25px;
    height: 8px;
    bottom: -5px;
    left: 2px;
    background: radial-gradient(ellipse, rgba(0, 0, 0, 0.3) 0%, transparent 70%);
    border-radius: 50%;
  }
}

/* 浮动装饰元素 */
.floating-elements {
  position: absolute;
  inset: 0;
  pointer-events: none;

  .float-item {
    position: absolute;
    opacity: 0.7;
    animation: float-random 6s ease-in-out infinite;

    &.triangle {
      width: 0;
      height: 0;
      border-left: 8px solid transparent;
      border-right: 8px solid transparent;
      border-bottom: 14px solid rgba(140, 160, 255, 0.6);
      top: 15%;
      left: 25%;
      animation-delay: 0s;
    }

    &.circle {
      width: 12px;
      height: 12px;
      background: radial-gradient(circle, rgba(124, 58, 237, 0.8) 0%, rgba(100, 130, 255, 0.4) 100%);
      border-radius: 50%;
      top: 60%;
      right: 30%;
      animation-delay: 1s;
    }

    &.pentagon {
      width: 10px;
      height: 10px;
      background: rgba(255, 183, 77, 0.7);
      transform: rotate(45deg);
      top: 80%;
      left: 15%;
      animation-delay: 2s;
    }

    &.star {
      width: 8px;
      height: 8px;
      background: rgba(255, 255, 255, 0.8);
      clip-path: polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%);
      top: 35%;
      right: 15%;
      animation-delay: 3s;
    }
  }
}

/* 3D平台基座 */
.platform-base {
  position: absolute;
  bottom: 0;
  left: 50%;
  transform: translateX(-50%);
  width: 400px;
  height: 60px;
  transform-style: preserve-3d;

  .platform-top {
    position: absolute;
    width: 400px;
    height: 200px;
    background: linear-gradient(135deg, rgba(100, 130, 255, 0.15) 0%, rgba(85, 116, 231, 0.1) 100%);
    transform: rotateX(90deg) translateZ(60px);
    border-radius: 50%;
  }

  .platform-side {
    position: absolute;
    width: 400px;
    height: 60px;
    background: linear-gradient(180deg, rgba(85, 116, 231, 0.08) 0%, rgba(77, 97, 255, 0.05) 100%);
    transform: translateZ(-100px);
    border-radius: 200px 200px 0 0;
  }

  .platform-front {
    position: absolute;
    bottom: 0;
    width: 400px;
    height: 60px;
    background: linear-gradient(180deg, rgba(77, 97, 255, 0.12) 0%, rgba(60, 80, 200, 0.08) 100%);
    border-radius: 200px 200px 0 0;
  }

  .platform-shadow {
    position: absolute;
    bottom: -20px;
    left: 50%;
    transform: translateX(-50%);
    width: 300px;
    height: 20px;
    background: radial-gradient(ellipse, rgba(0, 0, 0, 0.2) 0%, transparent 70%);
    border-radius: 50%;
  }
}

.hero-content {
  position: absolute;
  right: 52px;
  bottom: 370px;
  text-align: right;
  color: #edf2ff;
  animation: hero-fade-in 1s ease-out;
  z-index: 10;

  .hero-tag {
    display: inline-block;
    padding: 7px 16px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.14);
    border: 1.5px solid rgba(255, 255, 255, 0.25);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.22em;
    margin-bottom: 14px;
    backdrop-filter: blur(12px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    transition: all 0.3s ease;

    &:hover {
      background: rgba(255, 255, 255, 0.2);
      transform: translateY(-2px);
    }
  }

  .hero-title {
    margin: 0;
    font-size: 78px;
    font-weight: 900;
    letter-spacing: 0.04em;
    background: linear-gradient(180deg, #ffffff 0%, #dae4ff 50%, #c5d4ff 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.15)) drop-shadow(0 8px 32px rgba(0, 0, 0, 0.1));
    line-height: 0.95;
    animation: title-glow 3s ease-in-out infinite alternate;
  }

  .hero-subtitle {
    margin: 16px 0 0;
    font-size: 15px;
    opacity: 0.94;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  }
}

@keyframes hero-fade-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes title-glow {
  from {
    filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.15)) drop-shadow(0 8px 32px rgba(0, 0, 0, 0.1));
  }
  to {
    filter: drop-shadow(0 6px 16px rgba(0, 0, 0, 0.2)) drop-shadow(0 12px 40px rgba(100, 130, 255, 0.15));
  }
}

/* 新增动画关键帧 */
@keyframes chart-rotate {
  0%,
  100% {
    transform: rotateX(20deg) rotateY(35deg);
  }
  50% {
    transform: rotateX(25deg) rotateY(30deg);
  }
}

@keyframes bar-grow {
  0% {
    transform: scaleY(0.8);
  }
  100% {
    transform: scaleY(1.1);
  }
}

@keyframes coin-float {
  0%,
  100% {
    transform: translateY(0px) rotateY(0deg);
  }
  50% {
    transform: translateY(-8px) rotateY(15deg);
  }
}

@keyframes character-wave {
  0%,
  100% {
    transform: translateY(0px) rotateZ(0deg);
  }
  50% {
    transform: translateY(-6px) rotateZ(3deg);
  }
}

@keyframes float-random {
  0%,
  100% {
    transform: translateY(0px) rotate(0deg);
    opacity: 0.7;
  }
  33% {
    transform: translateY(-10px) rotate(120deg);
    opacity: 0.9;
  }
  66% {
    transform: translateY(-5px) rotate(240deg);
    opacity: 0.5;
  }
}

/* 响应式适配 */
@media (max-width: 960px) {
  .modal-content-wrapper {
    flex-direction: column;
    border-radius: 16px;

    &::before {
      background: radial-gradient(ellipse 150% 100% at 50% -30%, rgba(255, 255, 255, 0.98) 0%, rgba(255, 255, 255, 0.95) 40%, transparent 60%),
        linear-gradient(180deg, #5876eb 0%, #4a63d8 40%, #3d52c6 70%, #2e3f9f 100%);
    }

    &::after {
      display: none;
    }
  }

  .login-content {
    width: 100%;
  }

  .illustration-content {
    min-height: 300px;
  }

  .hero-content {
    right: 32px;
    bottom: 120px;

    .hero-title {
      font-size: 56px;
    }
  }

  .feature-cards {
    flex-direction: column;
    left: 24px;
    bottom: 24px;
    gap: 10px;
  }
}

@media (max-width: 640px) {
  .premium-login-modal {
    :deep(.ant-modal) {
      max-width: 95vw;
      margin: 16px auto;
    }
  }

  .illustration-content {
    min-height: 250px;
  }

  .hero-content {
    .hero-title {
      font-size: 48px;
    }
  }

  .feature-cards {
    display: none;
  }
}
</style>
