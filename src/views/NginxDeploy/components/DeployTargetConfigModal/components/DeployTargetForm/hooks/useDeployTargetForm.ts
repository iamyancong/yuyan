/**
 * 部署目标配置表单核心状态 Hook
 * @description 管理表单模型、服务器实例联动及全宽文件浏览器状态
 */

import { computed, onUnmounted, ref, watch } from 'vue';
import { message } from 'ant-design-vue';
import { readNginxConf, type DeployServer, type NginxInstance, type DeployTargetPayload } from '@/api/deploy';
import type { FormilyRef } from '../../../../../types';
import { useNginxDeployContext } from '../../../../../hooks/useNginxDeployContext';
import { getErrorMessage, getPreferredNginxInstance } from '../../../../../utils';
import { resolveLockedScope } from '../../DeployRootField/constant.ts';
import {
  formatListenPortSyncHint,
  getVisitUrlPortMismatch,
} from '../../../../../hooks/visitUrlPortPolicy.ts';
import {
  buildListenPortSyncPlan,
  formatAmbiguousListenPortsHint,
  parseNginxListenPorts,
  resolveListenPortSuggestion,
} from '../../../../../hooks/nginxListenSyncPolicy.ts';
import {
  normalizeApplicationKind,
  resolveApplicationKind,
  shouldShowListenPort,
} from '../../../../../hooks/applicationKindPolicy.ts';
import { confirmListenPortSync } from '../../../../../hooks/listenPortSyncPrompt';
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

  /** 表单挂载时（该组件随弹窗 v-if 挂载）或 targetId 切换时捕获的已保存 applicationKind */
  const baselineKind = ref(normalizeApplicationKind(props.form.applicationKind));
  const detectedKind = ref<'main' | 'micro' | ''>('');

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

  /** 将识别或已保存的 applicationKind 写回 formModel（值未变时不写，避免循环） */
  const updateResolvedKind = () => {
    const resolved = resolveApplicationKind({
      detected: detectedKind.value,
      saved: baselineKind.value,
    });
    if ((formModel.value.applicationKind || '') !== resolved) {
      formModel.value = {
        ...formModel.value,
        applicationKind: resolved,
      };
    }
  };

  /** 响应子组件回流的探测应用类型 */
  const handleDetectedKind = (kind: 'main' | 'micro' | '') => {
    detectedKind.value = normalizeApplicationKind(kind);
    updateResolvedKind();
  };

  let lastTargetId = props.targetId;

  watch(
    () => props.targetId,
    () => {
      baselineKind.value = normalizeApplicationKind(props.form.applicationKind);
      updateResolvedKind();
      queueMicrotask(() => {
        lastTargetId = props.targetId;
      });
    }
  );

  watch(
    () => props.form.projectId,
    () => {
      if (props.targetId !== lastTargetId) {
        return;
      }
      baselineKind.value = '';
      detectedKind.value = '';
      updateResolvedKind();
    }
  );

  /** 访问地址端口与监听端口的不一致检测（后端目标或微应用隐藏端口时返回 null，不展示提示） */
  const listenPortMismatch = computed(() => {
    if (!shouldShowListenPort({
      projectType: formModel.value.projectType,
      applicationKind: formModel.value.applicationKind,
      nginxSiteManaged: formModel.value.nginxSiteManaged,
    })) {
      return null;
    }
    return getVisitUrlPortMismatch(formModel.value.visitUrl, formModel.value.listenPort);
  });

  /** 字段旁的提示文案，例如「访问地址是 8050，当前监听端口仍是 9999」 */
  const listenPortSyncHint = computed(() => (
    listenPortMismatch.value ? formatListenPortSyncHint(listenPortMismatch.value) : ''
  ));

  /** 「同步为 xxx」按钮要写入的端口 */
  const listenPortSyncValue = computed(() => listenPortMismatch.value?.visitPort ?? null);

  /** 托管站点由平台分配端口；已有实例填 Nginx 实际 listen 的端口 */
  const listenPortPlaceholder = computed(() => (
    formModel.value.nginxSiteManaged ? '自动分配' : 'Nginx 实际监听端口'
  ));

  /**
   * 用户点击「同步为 xxx」：只把监听端口改成访问地址解析出的端口，访问地址保持不变。
   * @returns 写入的端口；无需同步时返回 null
   */
  const applyListenPortSync = (): number | null => {
    const nextPort = listenPortSyncValue.value;
    if (!nextPort) return null;
    formModel.value = { ...formModel.value, listenPort: nextPort };
    return nextPort;
  };

  /** 「从 Nginx 配置同步」读取中 */
  const syncingListenPortFromConf = ref(false);

  /** 只有已保存的目标才有服务器上的配置文件可读 */
  const canSyncListenPortFromConf = computed(() => Boolean(props.targetId) && formModel.value.projectType !== 'backend');

  /**
   * 服务器上手工改了 listen 后，在表单里一键读取并询问同步。
   * @description 只读取该目标已保存的 Nginx 配置文件（readNginxConf），不扫描整机；
   * 确定后只改表单里的监听端口（访问地址端口正好等于旧监听端口时才跟着改），点「保存」才真正写入。
   */
  const syncListenPortFromNginxConf = async () => {
    const targetId = Number(props.targetId || 0);
    if (!targetId || syncingListenPortFromConf.value) return;
    syncingListenPortFromConf.value = true;
    let config: { path: string; content: string };
    try {
      config = await readNginxConf(targetId);
    } catch (error) {
      message.error(`读取 Nginx 配置文件失败：${getErrorMessage(error)}`);
      return;
    } finally {
      syncingListenPortFromConf.value = false;
    }
    if (Number(props.targetId || 0) !== targetId) return;
    const suggestion = resolveListenPortSuggestion({
      currentListenPort: formModel.value.listenPort,
      nextPorts: parseNginxListenPorts(config.content),
    });
    const pathLabel = config.path ? `（${config.path}）` : '';
    if (suggestion.kind === 'no-listen') {
      message.warning(`Nginx 配置文件${pathLabel}里没有找到可识别的 listen 指令`);
      return;
    }
    if (suggestion.kind === 'in-sync') {
      message.success(`Nginx 配置里的监听端口与当前一致（${suggestion.listenPort}），无需同步`);
      return;
    }
    if (suggestion.kind === 'ambiguous') {
      message.warning(formatAmbiguousListenPortsHint(suggestion.ports), 6);
      return;
    }
    if (suggestion.kind !== 'suggest') return;
    const plan = buildListenPortSyncPlan(suggestion, String(formModel.value.visitUrl || ''));
    if (!(await confirmListenPortSync(suggestion, plan, '同步到表单'))) return;
    if (Number(props.targetId || 0) !== targetId) return;
    // 访问地址与监听端口一次写入：托管站点的端口联动 watch 看到访问地址已是新端口就不会重复改写
    formModel.value = { ...formModel.value, visitUrl: plan.visitUrl, listenPort: plan.listenPort };
    formRef.value?.setValues?.({ visitUrl: plan.visitUrl, listenPort: plan.listenPort });
    message.success(`监听端口已改为 ${plan.listenPort}，点「保存」后生效`);
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
    handleDetectedKind,
    listenPortSyncHint,
    listenPortSyncValue,
    listenPortPlaceholder,
    applyListenPortSync,
    syncingListenPortFromConf,
    canSyncListenPortFromConf,
    syncListenPortFromNginxConf,
  };
}
