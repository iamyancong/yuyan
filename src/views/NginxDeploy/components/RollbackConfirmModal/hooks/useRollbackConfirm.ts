import { computed } from 'vue';
import {
  getRecordCommitSummary,
  ROLLBACK_EXECUTION_NOTICES,
  UNDO_ROLLBACK_EXECUTION_NOTICES,
  type RollbackConfirmModalProps,
} from '../constant';


/**
 * 回滚确认卡片逻辑 Hook
 * @param props 弹窗属性
 */
export function useRollbackConfirm(props: RollbackConfirmModalProps) {
  /** 是否为撤销回滚模式 */
  const isUndo = computed(() => props.action === 'undoRollback');

  /** 弹窗主标题 */
  const modalTitle = computed(() => {
    return isUndo.value ? '确认撤销回滚？' : '确认立即回滚？';
  });

  /** 危险确认按钮文字 */
  const confirmButtonText = computed(() => {
    return isUndo.value ? '确认撤销回滚' : '确认立即回滚';
  });

  /** 当前线上运行的记录 */
  const currentRecord = computed(() => props.record);

  /** 目标待恢复的记录（根据 backupRecordId 匹配） */
  const targetRecord = computed(() => {
    if (!props.record?.backupRecordId) return null;
    const backupId = Number(props.record.backupRecordId);
    return props.records?.find((item) => Number(item.id) === backupId) || null;
  });

  /** 当前版本提交摘要 */
  const currentSummary = computed(() => getRecordCommitSummary(currentRecord.value));

  /** 目标版本提交摘要 */
  const targetSummary = computed(() => {
    if (targetRecord.value) {
      return getRecordCommitSummary(targetRecord.value);
    }
    return {
      sha: `备份 #${props.record?.backupRecordId || '-'}`,
      message: '历史备份快照版本',
      author: '系统备份',
      time: '-',
    };
  });

  /** 副作用说明条目 */
  const notices = computed(() => {
    return isUndo.value ? UNDO_ROLLBACK_EXECUTION_NOTICES : ROLLBACK_EXECUTION_NOTICES;
  });

  return {
    isUndo,
    modalTitle,
    confirmButtonText,
    currentRecord,
    targetRecord,
    currentSummary,
    targetSummary,
    notices,
  };
}
