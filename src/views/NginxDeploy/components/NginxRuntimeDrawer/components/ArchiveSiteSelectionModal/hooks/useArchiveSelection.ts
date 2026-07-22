import { computed, ref, watch } from 'vue';
import type { NginxArchiveDownloadType } from '@/api/deploy';
import { ARCHIVE_TYPE_OPTIONS, type ArchiveSiteSelectionModalProps } from '../constant';
import {
  canSubmitArchiveSelection,
  getSelectableArchiveSites,
  normalizeArchiveSiteIds,
} from '../selectionPolicy';

/** 归档选择弹窗事件。 */
interface ArchiveSelectionModalEmit {
  (e: 'update:open', value: boolean): void;
  (e: 'refresh'): void;
  (e: 'confirm', value: { type: NginxArchiveDownloadType; siteIds: string[] }): void;
}

/**
 * 管理归档类型与 server 选择状态。
 * @param props 弹窗属性
 * @param emit 弹窗事件发送器
 * @returns 归档选择状态与交互方法
 */
export const useArchiveSelection = (
  props: ArchiveSiteSelectionModalProps,
  emit: ArchiveSelectionModalEmit
) => {
  const selectedType = ref<NginxArchiveDownloadType>('all');
  const selectedSiteIds = ref<string[]>([]);
  const selectableSites = computed(() => getSelectableArchiveSites(props.sites, selectedType.value));
  const canConfirm = computed(() => canSubmitArchiveSelection(
    selectedSiteIds.value,
    props.loading,
    props.downloading
  ));
  const selectedArchiveOption = computed(() => (
    ARCHIVE_TYPE_OPTIONS.find((option) => option.value === selectedType.value) ?? ARCHIVE_TYPE_OPTIONS[0]
  ));

  watch(
    () => props.open,
    (open) => {
      if (!open) return;
      selectedType.value = props.type;
      selectedSiteIds.value = [];
    }
  );

  watch([selectedType, () => props.sites], () => {
    selectedSiteIds.value = normalizeArchiveSiteIds(selectedSiteIds.value, props.sites, selectedType.value);
  });

  /** 更新经过当前归档类型过滤后的 server 选择。 */
  const updateSelectedSiteIds = (siteIds: string[]) => {
    selectedSiteIds.value = normalizeArchiveSiteIds(siteIds, props.sites, selectedType.value);
  };

  /** 选中当前归档类型下的全部可用 server。 */
  const selectAll = () => {
    selectedSiteIds.value = selectableSites.value.map((site) => site.id);
  };

  /** 清空全部 server 选择。 */
  const clearAll = () => {
    selectedSiteIds.value = [];
  };

  /** 提交当前归档选择。 */
  const confirmSelection = () => {
    if (!canConfirm.value) return;
    emit('confirm', { type: selectedType.value, siteIds: selectedSiteIds.value });
  };

  return {
    canConfirm,
    clearAll,
    confirmSelection,
    selectableSites,
    selectedArchiveOption,
    selectedSiteIds,
    selectedType,
    selectAll,
    updateSelectedSiteIds,
  };
};
