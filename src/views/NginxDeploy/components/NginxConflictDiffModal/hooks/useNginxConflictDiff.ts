import { computed, ref, watch } from 'vue';
import type { NginxConflictDiffModalProps } from '../constant';
import { useNginxDiff } from '../../NginxConfigDrawer/hooks/useNginxDiff';

/**
 * Nginx 冲突差异对比 Composable
 * @param props 弹窗属性
 * @param emit 事件触发器
 */
export function useNginxConflictDiff(
  props: NginxConflictDiffModalProps,
  emit: {
    (e: 'update:open', value: boolean): void;
    (e: 'confirm', expectedSha256: string): void;
  }
) {
  const currentContent = ref('');
  const generatedContent = ref('');
  const isRawDirty = ref(true);
  const isSemanticDirty = ref(true);

  // 同步冲突内容到本地 ref
  watch(
    () => props.conflictData,
    (newData) => {
      currentContent.value = newData?.currentContent || '';
      generatedContent.value = newData?.generatedContent || '';
    },
    { immediate: true }
  );

  // 复用 #31 的 useNginxDiff 核心能力
  const {
    diffMode,
    diffSummary,
    currentChangeIndex,
    totalChanges,
    bindDiffEditor,
    handleNextDiff,
    handlePrevDiff,
    resetDiffState,
  } = useNginxDiff(generatedContent, currentContent, isRawDirty, isSemanticDirty);

  // 冲突对比弹窗始终保持 Diff 模式
  diffMode.value = true;

  // 弹窗关闭时重置 diff 状态
  watch(
    () => props.open,
    (isOpen) => {
      if (!isOpen) {
        resetDiffState();
      }
    }
  );

  /** 弹窗标题 */
  const modalTitle = computed(() => {
    if (props.title) return props.title;
    if (props.target?.projectName) return `检测到远程站点配置文件冲突（${props.target.projectName}）`;
    return '检测到远程 Nginx 配置文件冲突';
  });

  /** 冲突原因描述 */
  const conflictReason = computed(() => {
    return props.conflictData?.reason || '远程配置文件已存在且被手工修改过或属于其他来源';
  });

  /** 触发确认覆盖接管 */
  const handleConfirm = () => {
    const sha = props.conflictData?.currentSha256 || '';
    emit('confirm', sha);
  };

  /** 关闭/取消弹窗 */
  const handleCancel = () => {
    emit('update:open', false);
  };

  return {
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
  };
}
