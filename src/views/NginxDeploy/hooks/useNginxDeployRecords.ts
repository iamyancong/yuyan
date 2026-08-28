import { computed, reactive, ref, watch, type Ref } from 'vue';
import message from 'ant-design-vue/es/message';
import {
  getDeployRecord,
  listDeployRecords,
  listDeployTargets,
  type DeployRecord,
  type DeployRecordQuery,
  type DeployTarget,
} from '@/api/deploy';
import type { DeployProjectContext, RecordProjectOption, RefreshActiveTabOptions } from '../types';
import { createBranchOptions, createRecordServerOptions, createRecordTargetOptions, getErrorMessage } from '../utils';

import { useNginxDeployContext } from './useNginxDeployContext';
import { renderTwoLineSelectOption } from './useDeployProjectOptions';

/** 发布历史 Hook 参数 */
interface UseNginxDeployRecordsParams {
  project?: DeployProjectContext;
  hasProjectContext?: Ref<boolean>;
  authState?: Readonly<Ref<{ token?: string | null; host?: string | null }>>;
  ensureLoggedIn?: () => boolean;
  refreshActiveTab?: (options?: RefreshActiveTabOptions) => Promise<void>;
  projectType?: Ref<'all' | 'frontend' | 'backend'>;
}

/**
 * 管理发布历史列表、筛选条件、分页和日志抽屉。
 * @description 支持零传参的依赖注入，解耦原本扁平化的数据传递网络。
 * @param params 可选发布历史依赖
 * @returns 发布历史数据、筛选状态和操作方法
 */
export function useNginxDeployRecords(params?: UseNginxDeployRecordsParams) {
  const fallbackContext = useNginxDeployContext;
  const getContext = () => {
    try {
      return fallbackContext();
    } catch {
      return null;
    }
  };
  const context = getContext();

  const project = params?.project ?? context?.project!;
  const hasProjectContext = params?.hasProjectContext ?? context?.hasProjectContext!;
  const authState = params?.authState ?? context?.authState!;
  const ensureLoggedIn = params?.ensureLoggedIn ?? context?.ensureLoggedIn!;
  const refreshActiveTab = params?.refreshActiveTab ?? context?.refreshActiveTab!;
  const projectType = params?.projectType ?? context?.projectType ?? ref<'all' | 'frontend' | 'backend'>('all');

  const recordLogLoading = ref(false);
  const records = ref<DeployRecord[]>([]);
  const recordTargets = ref<DeployTarget[]>([]);
  const recordServerFilter = ref<number | undefined>();
  const recordTargetFilter = ref<string | undefined>();
  const recordProjectFilter = recordTargetFilter;
  const recordBranchFilter = ref<string | undefined>();
  const recordLogOpen = ref(false);
  const activeRecord = ref<DeployRecord | null>(null);
  let recordRefreshSequence = 0;
  let applyContextDefaults = true;

  const filteredTargets = computed(() => {
    if (!projectType.value || projectType.value === 'all') {
      return recordTargets.value;
    }
    return recordTargets.value.filter((target) => target.projectType === projectType.value);
  });

  const recordPagination = reactive({
    current: 1,
    pageSize: 20,
    total: 0,
    remote: true,
    responsive: true,
    showLessItems: true,
    showSizeChanger: true,
    showQuickJumper: true,
    showTotal: (total: number, range: [number, number]) => `第 ${range[0]}-${range[1]} 条，共 ${total} 条`,
  });

  const recordServerOptions = computed(() => createRecordServerOptions(filteredTargets.value));

  const recordTargetOptions = computed<RecordProjectOption[]>(() =>
    createRecordTargetOptions(
      recordServerFilter.value
        ? filteredTargets.value.filter((target) => Number(target.serverId || 0) === Number(recordServerFilter.value))
        : filteredTargets.value
    )
  );

  const recordProjectOptions = recordTargetOptions;

  const recordBranchOptions = computed(() => {
    const selected = recordTargetOptions.value.find((option) => option.value === recordTargetFilter.value);
    const selectedTargetId = Number(selected?.targetId || 0);
    const eligibleTargets = selectedTargetId
      ? filteredTargets.value.filter((target) => Number(target.id || 0) === selectedTargetId)
      : recordServerFilter.value
        ? filteredTargets.value.filter((target) => Number(target.serverId || 0) === Number(recordServerFilter.value))
        : filteredTargets.value;
    return createBranchOptions(eligibleTargets).map((opt) => {
      const name = String(opt.value);
      return {
        label: renderTwoLineSelectOption({ title: name, description: '代码分支' }),
        title: name,
        searchKey: `${name} 代码分支`,
        value: name,
      };
    });
  });

  /**
   * 查找当前项目上下文对应的部署目标。
   * @param targetList 部署目标列表
   * @returns 匹配的部署目标
   */
  const findContextTarget = (targetList: DeployTarget[]) => {
    if (!hasProjectContext.value) return undefined;
    return targetList.find((target) => {
      if (project.projectId && Number(target.projectId || 0) === Number(project.projectId)) return true;
      if (project.projectPath && target.projectPath === project.projectPath) return true;
      return Boolean(project.projectName && target.projectName === project.projectName);
    });
  };

  /**
   * 确保发布历史存在明确的服务器筛选项。
   * @param targetList 部署目标列表
   */
  const ensureRecordServerFilter = (targetList: DeployTarget[]) => {
    const current = Number(recordServerFilter.value || 0);
    if (current && recordServerOptions.value.some((option) => option.value === current)) return;
    const contextTarget = applyContextDefaults ? findContextTarget(targetList) : undefined;
    recordServerFilter.value = contextTarget?.serverId || undefined;
    recordPagination.current = 1;
  };

  /** 确保发布历史存在明确的项目筛选项 */
  const ensureRecordTargetFilter = () => {
    const current = recordTargetFilter.value;
    if (current && recordTargetOptions.value.some((option) => option.value === current)) return;
    const serverTargets = recordServerFilter.value
      ? filteredTargets.value.filter((target) => Number(target.serverId || 0) === Number(recordServerFilter.value))
      : filteredTargets.value;
    const contextTarget = applyContextDefaults ? findContextTarget(serverTargets) : undefined;
    const contextValue = contextTarget ? `target:${contextTarget.id}` : undefined;
    const contextOption = recordTargetOptions.value.find((option) => option.value === contextValue);
    recordTargetFilter.value = contextOption?.value;
    recordPagination.current = 1;
  };

  /** 确保发布历史分支筛选仍然有效 */
  const ensureRecordBranchFilter = () => {
    const current = recordBranchFilter.value;
    if (!current) return;
    if (recordBranchOptions.value.some((option) => option.value === current)) return;
    recordBranchFilter.value = undefined;
    recordPagination.current = 1;
  };

  /**
   * 获取当前发布历史项目查询参数。
   * @returns 当前聚合筛选查询参数
   */
  const getRecordProjectQuery = (): DeployRecordQuery => {
    const selected = recordTargetOptions.value.find((option) => option.value === recordTargetFilter.value);
    const query: DeployRecordQuery = {};
    if (selected?.targetId) query.targetId = selected.targetId;
    if (!selected?.targetId && recordServerFilter.value) query.serverId = recordServerFilter.value;
    if (projectType.value === 'frontend' || projectType.value === 'backend') query.projectType = projectType.value;
    if (recordBranchFilter.value) query.branch = recordBranchFilter.value;
    return query;
  };

  /** 重置发布历史页码 */
  const resetRecordPage = () => {
    recordPagination.current = 1;
  };

  /** 刷新发布历史项目选项 */
  const refreshRecordProjectOptions = async (options: RefreshActiveTabOptions = {}) => {
    const shouldReloadTargets = Boolean(options.reloadRecordTargets) || !recordTargets.value.length;
    if (shouldReloadTargets) {
      const targetList = await listDeployTargets();
      recordTargets.value = targetList;
    }
    ensureRecordServerFilter(filteredTargets.value);
    ensureRecordTargetFilter();
    ensureRecordBranchFilter();
    applyContextDefaults = false;
  };

  /** 刷新发布历史列表 */
  const refreshRecordList = async (options: RefreshActiveTabOptions = {}) => {
    const refreshSequence = ++recordRefreshSequence;
    await refreshRecordProjectOptions(options);
    if (refreshSequence !== recordRefreshSequence) return;
    const recordProjectQuery = getRecordProjectQuery();
    const recordList = await listDeployRecords(
      {
        ...recordProjectQuery,
        page: recordPagination.current,
        pageSize: recordPagination.pageSize,
      },
      authState.value.token || '',
      authState.value.host || ''
    );
    if (refreshSequence !== recordRefreshSequence) return;
    const targetMap = new Map<number, DeployTarget>();
    recordTargets.value.forEach((target) => targetMap.set(target.id, target));
    records.value = recordList.items.map((item) => {
      const target = targetMap.get(item.targetId);
      return {
        ...item,
        projectDescription: item.projectDescription || target?.projectDescription || '',
        serverId: item.serverId || target?.serverId || 0,
        serverName: item.serverName || target?.serverName || '',
        serverHost: item.serverHost || target?.serverHost || '',
      };
    });
    recordPagination.current = recordList.page;
    recordPagination.pageSize = recordList.pageSize;
    recordPagination.total = recordList.total;
  };

  /**
   * 查看发布日志。
   * @param record 发布记录
   */
  const openRecordLogs = async (record: DeployRecord) => {
    if (!ensureLoggedIn()) return;
    activeRecord.value = record;
    recordLogOpen.value = true;
    recordLogLoading.value = true;
    try {
      activeRecord.value = await getDeployRecord(record.id, authState.value.token || '', authState.value.host || '');
    } catch (error: any) {
      message.error(getErrorMessage(error));
    } finally {
      recordLogLoading.value = false;
    }
  };

  /**
   * 切换发布历史分页。
   * @param pageInfo 分页参数
   */
  const handleRecordPageChange = async (pageInfo: { current: number; pageSize: number }) => {
    recordPagination.current = pageInfo.current;
    recordPagination.pageSize = pageInfo.pageSize;
    await refreshActiveTab({ force: true });
  };

  /**
   * 切换发布历史项目筛选。
   * @param value 项目筛选值
   */
  const handleRecordProjectChange = async (value?: string) => {
    recordTargetFilter.value = value;
    recordBranchFilter.value = undefined;
    await refreshActiveTab({ resetRecordsPage: true, force: true });
  };

  /**
   * 切换发布历史服务器筛选。
   * @param value 服务器 ID
   */
  const handleRecordServerChange = async (value?: number) => {
    recordServerFilter.value = value;
    recordTargetFilter.value = undefined;
    recordBranchFilter.value = undefined;
    ensureRecordTargetFilter();
    await refreshActiveTab({ resetRecordsPage: true, force: true });
  };

  /**
   * 切换发布历史分支筛选。
   * @param value 分支名称
   */
  const handleRecordBranchChange = async (value?: string) => {
    recordBranchFilter.value = value;
    await refreshActiveTab({ resetRecordsPage: true, force: true });
  };

  /** 清空发布历史数据和临时态 */
  const clearRecordData = () => {
    recordRefreshSequence += 1;
    records.value = [];
    recordTargets.value = [];
    recordServerFilter.value = undefined;
    recordTargetFilter.value = undefined;
    recordBranchFilter.value = undefined;
    activeRecord.value = null;
    recordLogOpen.value = false;
    recordLogLoading.value = false;
    recordPagination.current = 1;
    recordPagination.total = 0;
    applyContextDefaults = true;
  };

  watch(projectType, () => {
    applyContextDefaults = false;
    recordRefreshSequence += 1;
    recordServerFilter.value = undefined;
    recordTargetFilter.value = undefined;
    recordBranchFilter.value = undefined;
    records.value = [];
    recordPagination.current = 1;
    recordPagination.total = 0;
  });

  return {
    recordLogLoading,
    records,
    recordServerFilter,
    recordTargetFilter,
    recordProjectFilter,
    recordBranchFilter,
    recordServerOptions,
    recordTargetOptions,
    recordProjectOptions,
    recordBranchOptions,
    recordPagination,
    recordLogOpen,
    activeRecord,
    resetRecordPage,
    refreshRecordList,
    openRecordLogs,
    handleRecordPageChange,
    handleRecordServerChange,
    handleRecordProjectChange,
    handleRecordBranchChange,
    clearRecordData,
  };
}
