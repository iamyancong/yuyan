<script setup lang="ts">
import { computed } from 'vue';
import { ArrowDownOutlined, ExclamationCircleOutlined } from '@ant-design/icons-vue';
import { YButton } from '@yss-ui/components/lite';
import type { RollbackConfirmModalProps } from './constant';
import { useRollbackConfirm } from './hooks/useRollbackConfirm';

defineOptions({ name: 'RollbackConfirmModal' });

const props = withDefaults(defineProps<RollbackConfirmModalProps>(), {
  record: null,
  records: () => [],
  action: 'rollback',
  loading: false,
});

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'confirm'): void;
}>();

const visible = computed({
  get: () => props.open,
  set: (val: boolean) => emit('update:open', val),
});

const {
  isUndo,
  modalTitle,
  confirmButtonText,
  currentSummary,
  targetSummary,
  notices,
} = useRollbackConfirm(props);

/** 触发确认操作 */
const handleConfirm = () => {
  emit('confirm');
};

/** 取消关闭 */
const handleCancel = () => {
  visible.value = false;
};
</script>

<template>
  <a-modal
    v-model:open="visible"
    :title="modalTitle"
    width="620px"
    class="rollback-confirm-modal"
    :footer="null"
    destroyOnClose
  >
    <div class="rollback-confirm-content">
      <div class="version-diff-container">
        <!-- 当前线上版本 -->
        <div class="version-box version-box--current">
          <div class="version-box__header">
            <span class="version-box__tag">当前线上运行版本（即将被替换）</span>
            <span class="version-box__time">{{ currentSummary.time }}</span>
          </div>
          <div class="version-box__commit">
            <span class="version-box__sha">{{ currentSummary.sha }}</span>
            <span class="version-box__msg" :title="currentSummary.message">{{ currentSummary.message }}</span>
          </div>
          <div class="version-box__meta">
            <span>操作人：{{ currentSummary.author }}</span>
          </div>
        </div>

        <div class="version-diff-arrow">
          <ArrowDownOutlined class="version-diff-arrow__icon" />
          <span>{{ isUndo ? '即将撤销回滚，恢复至' : '即将回滚线上现场，恢复至' }}</span>
        </div>

        <!-- 目标恢复版本 -->
        <div class="version-box version-box--target">
          <div class="version-box__header">
            <span class="version-box__tag">目标恢复版本（备份快照）</span>
            <span class="version-box__time">{{ targetSummary.time }}</span>
          </div>
          <div class="version-box__commit">
            <span class="version-box__sha">{{ targetSummary.sha }}</span>
            <span class="version-box__msg" :title="targetSummary.message">{{ targetSummary.message }}</span>
          </div>
          <div class="version-box__meta">
            <span>提交/操作人：{{ targetSummary.author }}</span>
          </div>
        </div>
      </div>

      <!-- 执行说明 -->
      <div class="execution-notices">
        <div class="execution-notices__title">
          <ExclamationCircleOutlined /> 执行保障说明：
        </div>
        <div class="execution-notices__grid">
          <div v-for="item in notices" :key="item.title" class="execution-notices__item">
            <span class="notice-icon">{{ item.icon }}</span>
            <div class="notice-text">
              <strong>{{ item.title }}</strong>
              <span>{{ item.desc }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 底部操作栏 -->
      <div class="rollback-confirm-footer">
        <YButton :disabled="loading" @click="handleCancel">取消</YButton>
        <YButton type="primary" danger :loading="loading" @click="handleConfirm">
          {{ confirmButtonText }}
        </YButton>
      </div>
    </div>
  </a-modal>
</template>

<style scoped lang="less">
@import './style.less';
</style>
