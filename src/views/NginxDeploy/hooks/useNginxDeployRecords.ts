import { computed, reactive, ref, type Ref } from 'vue';
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

/** 发布历史 Hook 参数 */
interface UseNginxDeployRecordsParams {
  project?: DeployProjectContext;
  hasProjectContext?: Ref<boolean>;
  allTargets?: Ref<DeployTarget[]>;
  authState?: Readonly<Ref<{ token?: string | null; host?: string | null }>>;
  ensureLoggedIn?: () => boolean;
  refreshActiveTab?: (options?: RefreshActiveTabOptions) => Promise<void>;
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
  const allTargets = params?.allTargets ?? context?.allTargets!;
  const authState = params?.authState ?? context?.authState!;
  const ensureLoggedIn = params?.ensureLoggedIn ?? context?.ensureLoggedIn!;
  const refreshActiveTab = params?.refreshActiveTab ?? context?.refreshActiveTab!;

  const recordLogLoading = ref(false);
  const records = ref<DeployRecord[]>([]);
  const recordServerFilter = ref<number | undefined>();
  const recordTargetFilter = ref('');
  const recordProjectFilter = recordTargetFilter;
  const recordBranchFilter = ref<string | undefined>();
  const recordLogOpen = ref(false);
  const activeRecord = ref<DeployRecord | null>(null);

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

  const recordServerOptions = computed(() => createRecordServerOptions(allTargets.value));

  const recordTargetOptions = computed<RecordProjectOption[]>(() =>
    createRecordTargetOptions(allTargets.value.filter((target) => Number(target.serverId || 0) === Number(recordServerFilter.value || 0)))
  );

  const recordProjectOptions = recordTargetOptions;

  const recordBranchOptions = computed(() => {
    const selected = recordTargetOptions.value.find((option) => option.value === recordTargetFilter.value);
    const selectedTargetId = Number(selected?.targetId || 0);
    if (!selectedTargetId) return [];
    return createBranchOptions(allTargets.value.filter((target) => Number(target.id || 0) === selectedTargetId));
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
    const contextTarget = findContextTarget(targetList);
    recordServerFilter.value = contextTarget?.serverId || recordServerOptions.value[0]?.value;
    recordPagination.current = 1;
  };

  /** 确保发布历史存在明确的项目筛选项 */
  const ensureRecordTargetFilter = () => {
    const current = recordTargetFilter.value;
    if (current && recordTargetOptions.value.some((option) => option.value === current)) return;
    const serverTargets = allTargets.value.filter((target) => Number(target.serverId || 0) === Number(recordServerFilter.value || 0));
    const contextTarget = findContextTarget(serverTargets);
    const contextValue = contextTarget ? `target:${contextTarget.id}` : '';
    const contextOption = recordTargetOptions.value.find((option) => option.value === contextValue);
    recordTargetFilter.value = contextOption?.value || recordTargetOptions.value[0]?.value || '';
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
   * @returns 查询参数；未选择项目时返回 null
   */
  const getRecordProjectQuery = (): DeployRecordQuery | null => {
    const selected = recordTargetOptions.value.find((option) => option.value === recordTargetFilter.value);
    if (!selected) return null;
    const query: DeployRecordQuery = {
      targetId: selected.targetId,
    };
    if (recordBranchFilter.value) query.branch = recordBranchFilter.value;
    return query;
  };

  /** 重置发布历史页码 */
  const resetRecordPage = () => {
    recordPagination.current = 1;
  };

  /** 刷新发布历史项目选项 */
  const refreshRecordProjectOptions = async () => {
    const targetList = await listDeployTargets();
    allTargets.value = targetList;
    ensureRecordServerFilter(targetList);
    ensureRecordTargetFilter();
    ensureRecordBranchFilter();
  };

  /** 刷新发布历史列表 */
  const refreshRecordList = async () => {
    await refreshRecordProjectOptions();
    const recordProjectQuery = getRecordProjectQuery();
    if (!recordProjectQuery) {
      records.value = [];
      recordPagination.total = 0;
      return;
    }
    const recordList = await listDeployRecords(
      {
        ...recordProjectQuery,
        page: recordPagination.current,
        pageSize: recordPagination.pageSize,
      },
      authState.value.token || '',
      authState.value.host || ''
    );
    records.value = recordList.items;
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
    await refreshActiveTab();
  };

  /**
   * 切换发布历史项目筛选。
   * @param value 项目筛选值
   */
  const handleRecordProjectChange = async (value: string) => {
    recordTargetFilter.value = value;
    ensureRecordBranchFilter();
    await refreshActiveTab({ resetRecordsPage: true });
  };

  /**
   * 切换发布历史服务器筛选。
   * @param value 服务器 ID
   */
  const handleRecordServerChange = async (value?: number) => {
    recordServerFilter.value = value;
    recordTargetFilter.value = '';
    recordBranchFilter.value = undefined;
    ensureRecordTargetFilter();
    await refreshActiveTab({ resetRecordsPage: true });
  };

  /**
   * 切换发布历史分支筛选。
   * @param value 分支名称
   */
  const handleRecordBranchChange = async (value?: string) => {
    recordBranchFilter.value = value;
    await refreshActiveTab({ resetRecordsPage: true });
  };

  /** 清空发布历史数据和临时态 */
  const clearRecordData = () => {
    records.value = [];
    recordServerFilter.value = undefined;
    recordTargetFilter.value = '';
    recordBranchFilter.value = undefined;
    activeRecord.value = null;
    recordLogOpen.value = false;
    recordLogLoading.value = false;
    recordPagination.current = 1;
    recordPagination.total = 0;
  };

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
