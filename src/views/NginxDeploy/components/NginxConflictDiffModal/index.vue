<script setup lang="ts">
import { computed } from 'vue';
import { ExclamationCircleOutlined } from '@ant-design/icons-vue';
import { YButton } from '@yss-ui/components/lite';
import { YMonacoDiff } from 'virtual:yss-heavy-components';
import NginxDiffToolbar from '../NginxConfigDrawer/components/NginxDiffToolbar/index.vue';
import { CONFLICT_DIFF_MONACO_OPTIONS, type NginxConflictDiffModalProps } from './constant';
import { useNginxConflictDiff } from './hooks/useNginxConflictDiff';

defineOptions({ name: 'NginxConflictDiffModal' });

const props = withDefaults(defineProps<NginxConflictDiffModalProps>(), {
  target: null,
  conflictData: null,
  loading: false,
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'confirm', expectedSha256: string): void;
}>();

const visible = computed({
  get: () => props.open,
  set: (val: boolean) => emit('update:open', val),
});

const {
  currentContent,
  generatedContent,
  diffMode,
  diffSummary,
  currentChangeIndex,
  totalChanges,
  modalTitle,
  conflictReason,
  bindDiffEditor,
  handleNextDiff,
  handlePrevDiff,
  handleConfirm,
  handleCancel,
} = useNginxConflictDiff(props, emit);
</script>

<template>
  <a-modal
    v-model:open="visible"
    :title="modalTitle"
    width="960px"
    class="nginx-conflict-diff-modal"
    :footer="null"
    destroy-on-close
    :mask-closable="false"
  >
    <a-alert
      type="warning"
      show-icon
      class="conflict-alert"
    >
      <template #icon><ExclamationCircleOutlined /></template>
      <template #message>
        <div>
          <span>{{ conflictReason }}。平台不会静默覆盖，请核对下方配置差异。</span>
          <div v-if="conflictData?.path" class="conflict-path">目标文件：{{ conflictData.path }}</div>
        </div>
      </template>
    </a-alert>

    <div class="conflict-editor-shell">
      <NginxDiffToolbar
        :is-dirty="true"
        :diff-mode="diffMode"
        :diff-summary="diffSummary"
        :current-change-index="currentChangeIndex"
        :total-changes="totalChanges"
        :content="generatedContent"
        @next-diff="handleNextDiff"
        @prev-diff="handlePrevDiff"
      />
      <div class="conflict-editor-header">
        <span class="side-title side-title--current">◀ 服务器当前配置（将被备份）</span>
        <span class="side-title side-title--generated">平台托管接管配置（即将写入） ▶</span>
      </div>
      <div class="conflict-editor-container">
        <YMonacoDiff
          :ref="bindDiffEditor"
          :original="currentContent"
          :value="generatedContent"
          language="nginx"
          theme="vs-dark"
          height="460px"
          :format-on-mount="false"
          :toolbar-tooltip="false"
          :toolbar-options="{ copy: false, fullscreen: false }"
          :options="CONFLICT_DIFF_MONACO_OPTIONS"
        />
      </div>
    </div>

    <div class="conflict-footer">
      <div class="footer-tip">覆盖前平台将自动在服务器生成 <code>.bak.&lt;timestamp&gt;</code> 备份</div>
      <div class="footer-actions">
        <YButton :disabled="loading" @click="handleCancel">取消</YButton>
        <YButton
          type="primary"
          danger
          :loading="loading"
          @click="handleConfirm"
        >
          覆盖并接管站点配置
        </YButton>
      </div>
    </div>
  </a-modal>
</template>

<style scoped lang="less">
@import './style.less';
</style>
