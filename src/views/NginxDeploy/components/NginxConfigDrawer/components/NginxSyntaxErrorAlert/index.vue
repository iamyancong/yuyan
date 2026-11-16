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
import type { ParsedNginxError, ScopedNginxError } from '../../utils/nginxErrorParser';
import type { NginxSaveFailureInfo } from '../../historyPolicy';

defineOptions({ name: 'NginxSyntaxErrorAlert' });

/** 属性定义 */
const props = defineProps<{
  error: (ParsedNginxError & Partial<Pick<ScopedNginxError, 'fileScope' | 'externalLocation'>>) | null;
  /** 是否可以只读查看报错所在的其他文件（需要知道服务器） */
  canViewFile?: boolean;
  /** 保存失败的阶段与回滚结果（#43 P1-2），为空时按普通语法错误展示 */
  failure?: NginxSaveFailureInfo | null;
}>();

/** 复制备份路径 */
const handleCopyBackup = async () => {
  if (!props.failure?.backupPath) return;
  if (await copyToClipboard(props.failure.backupPath)) message.success('备份路径已复制');
};

/** 事件定义 */
const emit = defineEmits<{
  (e: 'jump-to-line', line: number): void;
  (e: 'close'): void;
  (e: 'view-file', file: string, line: number | null): void;
}>();

/** 复制其他文件的报错位置 */
const handleCopyLocation = async () => {
  const loc = props.error?.externalLocation;
  if (!loc) return;
  const text = loc.line ? `${loc.file}:${loc.line}` : loc.file;
  if (await copyToClipboard(text)) message.success('报错位置已复制');
};

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
  <div v-if="error" :class="['nginx-syntax-error-alert', failure?.kind ? `is-${failure.kind}` : '']" role="alert">
    <!-- 保存阶段与回滚结果 -->
    <div v-if="failure && failure.kind !== 'other' && failure.kind !== 'conflict'" class="alert-stage">
      <span :class="['stage-headline', { 'is-severe': failure.severe, 'is-safe': !failure.severe }]">{{ failure.headline }}</span>
      <span class="stage-detail">{{ failure.detail }}</span>
      <span v-if="failure.kind === 'rollback-failed' && failure.backupPath" class="stage-backup">
        备份文件：<code>{{ failure.backupPath }}</code>
        <a-button size="small" type="link" @click="handleCopyBackup">复制路径</a-button>
      </span>
    </div>
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

    <!-- 报错在其他配置文件（#43 P1-1）：不在当前编辑器标红，指出真实文件 -->
    <div v-if="error.externalLocation" class="alert-external-file">
      <span class="label">报错文件：</span>
      <code class="external-path">{{ error.externalLocation.file }}</code>
      <a-tag v-if="error.externalLocation.line" color="warning" class="external-line">第 {{ error.externalLocation.line }} 行</a-tag>
      <span class="external-note">不是当前编辑的文件，编辑器中未标红</span>
      <a-button
        v-if="canViewFile"
        size="small"
        type="link"
        @click="emit('view-file', error.externalLocation.file, error.externalLocation.line)"
      >
        只读查看该文件
      </a-button>
      <a-button size="small" type="link" @click="handleCopyLocation">复制位置</a-button>
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
