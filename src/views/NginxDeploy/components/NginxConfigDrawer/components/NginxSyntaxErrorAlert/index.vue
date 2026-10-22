<script setup lang="ts">
import { ref } from 'vue';
import {
  ExclamationCircleFilled,
  AimOutlined,
  CloseOutlined,
  CopyOutlined,
  CheckOutlined,
} from '@ant-design/icons-vue';
import { copyToClipboard } from '@yss-ui/utils';
import message from 'ant-design-vue/es/message';
import type { ParsedNginxError } from '../../utils/nginxErrorParser';

defineOptions({ name: 'NginxSyntaxErrorAlert' });

/** 属性定义 */
const props = defineProps<{
  error: ParsedNginxError | null;
}>();

/** 事件定义 */
const emit = defineEmits<{
  (e: 'jump-to-line', line: number): void;
  (e: 'close'): void;
}>();

/** 是否展开原始终端日志 */
const showRaw = ref(false);

/** 复制成功状态 */
const copied = ref(false);

/** 切换原始日志展示 */
const toggleRaw = () => {
  showRaw.value = !showRaw.value;
};

/** 跳转到错误行 */
const handleJump = () => {
  if (props.error?.line) {
    emit('jump-to-line', props.error.line);
  }
};

/** 复制原始错误日志 */
const handleCopyRaw = async () => {
  if (!props.error?.rawError) return;
  try {
    await copyToClipboard(props.error.rawError);
    copied.value = true;
    message.success('原始日志已复制到剪贴板');
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    message.error('复制失败，请手动选择复制');
  }
};
</script>

<template>
  <div v-if="error" class="nginx-syntax-error-alert" role="alert">
    <!-- 头部：标题、行号 Tag 与快捷操作 -->
    <div class="alert-header">
      <div class="header-left">
        <ExclamationCircleFilled style="color: #ff4d4f; font-size: 15px;" />
        <span>{{ error.title }}</span>
        <a-tag
          v-if="error.line"
          color="error"
          class="line-tag"
          @click="handleJump"
          title="点击定位到该行"
        >
          第 {{ error.line }} 行
        </a-tag>
      </div>
      <div class="header-actions">
        <a-button
          v-if="error.line"
          size="small"
          type="primary"
          danger
          ghost
          class="jump-btn"
          @click="handleJump"
        >
          <template #icon><AimOutlined /></template>
          定位到该行
        </a-button>
        <a-button
          size="small"
          type="link"
          class="toggle-raw-btn"
          @click="toggleRaw"
        >
          {{ showRaw ? '收起终端输出' : '查看终端输出' }}
        </a-button>
        <a-button
          size="small"
          type="text"
          class="close-btn"
          @click="emit('close')"
          title="关闭提示"
        >
          <CloseOutlined />
        </a-button>
      </div>
    </div>

    <!-- 诊断内容：核心原因与解决建议 -->
    <div class="alert-content">
      <div class="error-row">
        <span class="label">错误原因：</span>
        <span class="value">{{ error.reason }}</span>
      </div>
      <div class="error-row suggestion">
        <span class="label">修改建议：</span>
        <span class="value">{{ error.suggestion }}</span>
      </div>
    </div>

    <!-- 原始日志展开区域 -->
    <div v-if="showRaw" class="alert-raw-section">
      <div class="raw-header">
        <span>原始终端命令输出：</span>
        <a-button size="small" type="link" @click="handleCopyRaw">
          <template #icon>
            <CheckOutlined v-if="copied" />
            <CopyOutlined v-else />
          </template>
          {{ copied ? '已复制' : '复制原始日志' }}
        </a-button>
      </div>
      <pre class="raw-error-box">{{ error.rawError }}</pre>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
