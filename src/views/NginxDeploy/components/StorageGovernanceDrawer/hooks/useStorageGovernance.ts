import { computed, ref, watch } from 'vue';
import message from 'ant-design-vue/es/message';
import type { YTableActionConfig } from '@yss-ui/components/lite';
import {
  cleanTargetOrphanAssets,
  inspectNginxInstanceStorage,
  previewTargetOrphanAssets,
  pruneNginxInstanceBackups,
  type NginxStorageInspectionReport,
  type OrphanAssetsPreviewResult,
  type PruneNginxStorageBackupsPayload,
  type StorageAppInspectionItem,
} from '@/api/deploy';
import { formatStorageBytes } from '../constant';
import type { StorageGovernanceDrawerEmits, StorageGovernanceDrawerProps } from '../type';

/**
 * 管理存储诊断扫描、存量内嵌备份瘦身、CAS 对象池 GC 及无主静态资源两段式清理。
 * @param props - 抽屉属性
 * @param emit - 抽屉事件
 * @returns 状态、列操作配置与交互方法
 */
export const useStorageGovernance = (
  props: StorageGovernanceDrawerProps,
  emit: StorageGovernanceDrawerEmits
) => {
  const inspecting = ref(false);
  const cleaning = ref(false);
  const report = ref<NginxStorageInspectionReport | null>(null);
  const inlineAction = ref<NonNullable<PruneNginxStorageBackupsPayload['inlineAction']>>('keep_latest_1');
  const applyRetentionPolicy = ref(true);
  const runCasGc = ref(true);

  const orphanModalOpen = ref(false);
  const orphanLoading = ref(false);
  const orphanCleaning = ref(false);
  const orphanPreview = ref<OrphanAssetsPreviewResult | null>(null);
  const orphanMinAgeDays = ref(7);

  const visible = computed({
    get: () => props.open,
    set: (val: boolean) => emit('update:open', val),
  });

  const apps = computed<StorageAppInspectionItem[]>(() => report.value?.apps || []);
  const summary = computed(() => report.value?.summary || null);

  /** 拉取当前实例存储诊断报告 */
  const loadInspection = async () => {
    const instanceId = props.instance?.id;
    if (!instanceId) return;
    inspecting.value = true;
    try {
      report.value = await inspectNginxInstanceStorage(instanceId);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : '扫描存储占用失败';
      message.error(errMsg);
    } finally {
      inspecting.value = false;
    }
  };

  /** 执行全实例或指定目录的备份清理与对象池 GC */
  const executePruneBackups = async (override?: Partial<PruneNginxStorageBackupsPayload>) => {
    const instanceId = props.instance?.id;
    if (!instanceId || cleaning.value) return;
    cleaning.value = true;
    try {
      const res = await pruneNginxInstanceBackups(instanceId, {
        inlineAction: inlineAction.value,
        applyRetentionPolicy: applyRetentionPolicy.value,
        runCasGc: runCasGc.value,
        ...override,
      });
      const gcDesc = res.casGc && res.casGc.deletedObjects > 0
        ? `，对象池回收 ${res.casGc.deletedObjects} 个孤儿对象`
        : '';
      const dbDesc = res.clearedDbRecords > 0
        ? `，同步更新 ${res.clearedDbRecords} 条回滚记录`
        : '';
      message.success(
        `治理完成：删除 ${res.deletedBackups} 份旧备份，释放约 ${formatStorageBytes(res.freedBytes)}${gcDesc}${dbDesc}`
      );
      emit('cleaned');
      await loadInspection();
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : '执行备份清理失败';
      message.error(errMsg);
    } finally {
      cleaning.value = false;
    }
  };

  /** 打开单目标无主历史静态资源预览弹窗 */
  const openOrphanAssetsPreview = async (row: StorageAppInspectionItem, minAgeDays = orphanMinAgeDays.value) => {
    if (!row.targetId) {
      message.warning('该目录尚未纳管为部署目标，无法按发布清单扫描无主静态资源');
      return;
    }
    orphanMinAgeDays.value = minAgeDays;
    orphanModalOpen.value = true;
    orphanLoading.value = true;
    orphanPreview.value = null;
    try {
      orphanPreview.value = await previewTargetOrphanAssets(row.targetId, { minAgeDays });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : '扫描无主静态资源失败';
      message.error(errMsg);
    } finally {
      orphanLoading.value = false;
    }
  };

  /** 重新按新的宽限天数扫描当前目标的无主静态资源 */
  const reloadOrphanPreview = async (minAgeDays: number) => {
    const targetId = orphanPreview.value?.targetId;
    if (!targetId) return;
    orphanMinAgeDays.value = minAgeDays;
    orphanLoading.value = true;
    try {
      orphanPreview.value = await previewTargetOrphanAssets(targetId, { minAgeDays });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : '重新扫描无主静态资源失败';
      message.error(errMsg);
    } finally {
      orphanLoading.value = false;
    }
  };

  /** 提交清理已确认的无主历史静态资源 */
  const confirmCleanOrphanAssets = async (relativePaths: string[]) => {
    const current = orphanPreview.value;
    if (!current?.targetId || !current.previewToken || !relativePaths.length) return;
    orphanCleaning.value = true;
    try {
      const res = await cleanTargetOrphanAssets(current.targetId, {
        previewToken: current.previewToken,
        relativePaths,
      });
      message.success(`已清理 ${res.deletedCount} 个无主静态资源，释放 ${formatStorageBytes(res.freedBytes)}`);
      orphanModalOpen.value = false;
      emit('cleaned');
      await loadInspection();
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : '清理无主静态资源失败';
      message.error(errMsg);
    } finally {
      orphanCleaning.value = false;
    }
  };

  /** 应用明细表操作列配置 */
  const actionConfig = computed<YTableActionConfig>(() => ({
    width: 210,
    fixed: 'right',
    displayLimit: 2,
    buttons: [
      {
        key: 'cleanInline',
        text: '清理内嵌备份',
        type: 'link',
        isConfirm: true,
        confirmProps: {
          title: '确认清理该目录存量内嵌 .yuyan-backups（已迁外置仓将全清，否则保底留最新 1 份）？',
          okText: '立即清理',
          cancelText: '取消',
        },
        hideFn: ({ row }: { row: StorageAppInspectionItem }) => row.inlineBackupCount <= 0 && row.inlineManifestBytes <= 0,
        disabledFn: () => cleaning.value,
        clickFn: async ({ row }: { row: StorageAppInspectionItem }) => {
          await executePruneBackups({
            inlineAction: 'keep_latest_1',
            applyRetentionPolicy: true,
            runCasGc: true,
            targetRoots: row.deployRoot ? [row.deployRoot] : [row.key],
          });
        },
      },
      {
        key: 'scanOrphan',
        text: '扫描无主资源',
        type: 'link',
        hideFn: ({ row }: { row: StorageAppInspectionItem }) => row.targetId <= 0,
        disabledFn: () => cleaning.value,
        clickFn: ({ row }: { row: StorageAppInspectionItem }) => {
          void openOrphanAssetsPreview(row, 7);
        },
      },
    ],
  }));

  watch(
    () => [props.open, props.instance?.id],
    ([open]) => {
      if (open && props.instance?.id) {
        void loadInspection();
      }
    },
    { immediate: true }
  );

  return {
    actionConfig,
    applyRetentionPolicy,
    apps,
    cleaning,
    confirmCleanOrphanAssets,
    executePruneBackups,
    inlineAction,
    inspecting,
    loadInspection,
    orphanCleaning,
    orphanLoading,
    orphanMinAgeDays,
    orphanModalOpen,
    orphanPreview,
    reloadOrphanPreview,
    report,
    runCasGc,
    summary,
    visible,
  };
};
