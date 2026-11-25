<script setup lang="ts">
import { computed } from 'vue';
import { CloudDownloadOutlined } from '@ant-design/icons-vue';
import { YButton } from '@yss-ui/components/lite';
import { YMonacoDiff } from 'virtual:yss-heavy-components';
import type { TargetNginxCentralSnapshot } from '@/api/deploy';
import { HISTORY_DIFF_MONACO_OPTIONS } from '../../constant';
import { formatBeijingTime } from '../../historyPolicy';
import { formatSnapshotSourceLabel } from '../../centralRestorePolicy';

defineOptions({ name: 'CentralSnapshotDiffModal' });

interface Props {
  open: boolean;
  snapshot: TargetNginxCentralSnapshot | null;
  remoteContent: string;
  remoteExists: boolean;
  readonly?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  snapshot: null,
  remoteContent: '',
  remoteExists: true,
  readonly: false,
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'loadToEditor'): void;
}>();

const visible = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
});

const snapshotContent = computed(() => props.snapshot?.content || '');
const effectiveRemoteContent = computed(() => (props.remoteExists ? props.remoteContent : ''));

const leftTitle = computed(() => {
  const timeText = formatBeijingTime(props.snapshot?.updatedAt || '') || '时间未知';
  const sourceText = formatSnapshotSourceLabel(props.snapshot?.source);
  return `中央备份（${timeText}，来源：${sourceText}）`;
});

const rightTitle = computed(() => (props.remoteExists ? '线上当前' : '线上当前（文件不存在）'));
</script>

<template>
  <a-modal
    v-model:open="visible"
    title="从中央备份恢复 · 差异对比"
    width="min(1100px, 94vw)"
    class="central-snapshot-diff-modal"
    destroy-on-close
    :mask-closable="false"
  >
    <a-alert
      v-if="!remoteExists"
      type="warning"
      show-icon
      style="margin-bottom: 12px"
      message="线上文件不存在，载入编辑器并点击「保存并重载」后将在服务器上重新创建该配置文件。"
    />
    <div class="central-diff-shell">
      <div class="central-diff-header">
        <span class="side-title side-title--snapshot">◀ {{ leftTitle }}</span>
        <span class="side-title side-title--remote">{{ rightTitle }} ▶</span>
      </div>
      <div class="central-diff-container">
        <YMonacoDiff
          :original="snapshotContent"
          :value="effectiveRemoteContent"
          language="nginx"
          theme="vs-dark"
          height="480px"
          :auto-layout="true"
          :format-on-mount="false"
          :toolbar-tooltip="false"
          :toolbar-options="{ copy: false, fullscreen: false }"
          :options="HISTORY_DIFF_MONACO_OPTIONS"
        />
      </div>
    </div>

    <template #footer>
      <div class="central-diff-footer">
        <span class="footer-tip">载入编辑器不会自动覆盖线上配置，需手动确认后点击「保存并重载」</span>
        <a-space>
          <YButton @click="visible = false">关闭</YButton>
          <a-tooltip :title="readonly ? '只读角色不能恢复配置' : ''">
            <YButton type="primary" :disabled="readonly || !snapshot?.exists" @click="emit('loadToEditor')">
              <template #icon><CloudDownloadOutlined /></template>
              载入编辑器
            </YButton>
          </a-tooltip>
        </a-space>
      </div>
    </template>
  </a-modal>
</template>

<style scoped lang="less">
.central-diff-shell {
  border: 1px solid var(--border-color-split, #2d2d2d);
  border-radius: 8px;
  overflow: hidden;
  background: #1e1e1e;
}

.central-diff-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: #252526;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 12px;

  .side-title {
    font-weight: 500;

    &--snapshot {
      color: #69b1ff;
    }

    &--remote {
      color: #95de64;
    }
  }
}

.central-diff-container {
  height: 480px;
}

.central-diff-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;

  .footer-tip {
    font-size: 12px;
    color: var(--text-color-secondary, #8c8c8c);
  }
}
</style>
