/**
 * 远程路径输入与编辑状态 Hook
 */

import { nextTick, ref } from 'vue';

/**
 * 管理路径栏面包屑态与手动编辑输入态切换。
 * @param getPath 获取当前路径回调
 * @param updatePathInput 更新输入路径回调
 * @param onNavigateToPath 导航回调
 */
export function usePathEdit(
  getPath: () => string,
  updatePathInput: (val: string) => void,
  onNavigateToPath: () => void
) {
  const isEditingPath = ref(false);
  const inputRef = ref<HTMLInputElement>();

  const enterEditMode = async () => {
    updatePathInput(getPath());
    isEditingPath.value = true;
    await nextTick();
    inputRef.value?.focus();
  };

  const cancelEditMode = () => {
    updatePathInput(getPath());
    isEditingPath.value = false;
  };

  const submitPathEdit = () => {
    onNavigateToPath();
    isEditingPath.value = false;
  };

  return {
    isEditingPath,
    inputRef,
    enterEditMode,
    cancelEditMode,
    submitPathEdit,
  };
}
