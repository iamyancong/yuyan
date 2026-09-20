/**
 * 部署目标配置表单核心状态 Hook
 * @description 管理表单模型、服务器实例联动及全宽文件浏览器状态
 */

import { computed, onUnmounted, ref, watch } from 'vue';
import type { DeployServer, NginxInstance, DeployTargetPayload } from '@/api/deploy';
import type { FormilyRef } from '../../../../../types';
import { useNginxDeployContext } from '../../../../../hooks/useNginxDeployContext';
import { getPreferredNginxInstance } from '../../../../../utils';
import { resolveLockedScope } from '../../DeployRootField/constant.ts';
import type { DeployTargetFormEmits, DeployTargetFormProps } from '../constant.ts';

/**
 * 部署目标表单状态管理
 * @param props 组件属性
 * @param emit 事件发射器
 * @returns 响应式状态与操作方法
 */
export function useDeployTargetForm(
  props: DeployTargetFormProps,
  emit: DeployTargetFormEmits
) {
  const formRef = ref<FormilyRef | null>(null);
  const isExplorerOpen = ref(false);
  const occupiedMap = ref<Record<string, string>>({});

  /** 全局服务器列表上下文 */
  const { servers } = useNginxDeployContext();

  /** 部署目标表单双向绑定模型 */
  const formModel = computed({
    get: () => props.form,
    set: (value: Partial<DeployTargetPayload>) => emit('update:form', value || {}),
  });

  /** 当前选中的部署服务器 */
  const selectedServer = computed<DeployServer | null>(() => {
    if (!formModel.value.serverId) return null;
    return servers.value.find((s: DeployServer) => s.id === Number(formModel.value.serverId)) || null;
  });

  /** 当前选中的 Nginx 实例（未指定时自动回退为默认托管实例） */
  const selectedInstance = computed<NginxInstance | null>(() => {
    if (!selectedServer.value) return null;
    const currentId = Number(formModel.value.nginxInstanceId || 0);
    if (currentId) {
      const matched = selectedServer.value.nginxInstances?.find((i: NginxInstance) => i.id === currentId);
      if (matched) return matched;
    }
    return getPreferredNginxInstance(selectedServer.value) || null;
  });

  /** 锁定的根作用域路径与说明 */
  const lockedScope = computed(() =>
    resolveLockedScope(selectedServer.value, formModel.value.projectType, formModel.value.nginxInstanceId)
  );

  /** 切换全宽目录浏览器展开状态 */
  const toggleExplorer = () => {
    if (!selectedServer.value) return;
    isExplorerOpen.value = !isExplorerOpen.value;
  };

  /** 关闭目录浏览器 */
  const closeExplorer = () => {
    isExplorerOpen.value = false;
  };

  /** 选定目录路径回填到表单 */
  const handleSelectPath = (path: string) => {
    formModel.value = {
      ...formModel.value,
      deployRoot: path,
    };
  };

  /** 更新推荐占位映射字典 */
  const handleUpdateOccupiedMap = (map: Record<string, string>) => {
    occupiedMap.value = map || {};
  };

  watch(formRef, (instance) => emit('formRefChange', instance), { flush: 'post' });
  onUnmounted(() => emit('formRefChange', null));

  return {
    formRef,
    formModel,
    selectedServer,
    selectedInstance,
    lockedScope,
    isExplorerOpen,
    occupiedMap,
    toggleExplorer,
    closeExplorer,
    handleSelectPath,
    handleUpdateOccupiedMap,
  };
}
