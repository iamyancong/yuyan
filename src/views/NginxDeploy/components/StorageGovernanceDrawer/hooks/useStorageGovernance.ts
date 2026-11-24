import { computed, onBeforeUnmount, ref, watch } from 'vue';
import message from 'ant-design-vue/es/message';
import type { YTableActionConfig } from '@yss-ui/components/lite';
import {
  cancelNginxStoragePruneJob,
  cleanTargetOrphanAssets,
  getLatestNginxStoragePruneJob,
  getNginxStoragePruneJob,
  inspectNginxInstanceStorage,
  previewTargetOrphanAssets,
  startNginxStoragePruneJob,
  type NginxStorageInspectionReport,
  type OrphanAssetsPreviewResult,
  type PruneNginxStorageBackupsPayload,
  type StorageAppInspectionItem,
  type StoragePruneJobSnapshot,
} from '@/api/deploy';
import type { StoragePruneImpactSummary } from '../components/StoragePruneConfirmModal.vue';
import { formatStorageBytes } from '../constant';
import type { StorageGovernanceDrawerEmits, StorageGovernanceDrawerProps } from '../type';

/** 异步清理任务轮询间隔（毫秒） */
const PRUNE_POLL_INTERVAL_MS = 600;

/**
 * 判断某一行是否正处于单笔清理任务中。
 * @param row - 表格应用行
 * @param job - 当前异步清理任务快照
 * @returns 是否正在清理该行
 */
const isRowMatchedByJob = (row: StorageAppInspectionItem, job: StoragePruneJobSnapshot | null): boolean => {
  if (!job || job.status !== 'running' || job.scope !== 'single') return false;
  const targets = job.targetRoots || [];
  if (!targets.length) return false;
  return Boolean((row.deployRoot && targets.includes(row.deployRoot)) || targets.includes(row.key));
};

/**
 * 管理存储诊断扫描、后台异步备份清理（带实时进度与取消）、CAS 对象池 GC 及无主静态资源两段式清理。
 * @param props - 抽屉属性
 * @param emit - 抽屉事件
 * @returns 状态、列操作配置与交互方法
 */
export const useStorageGovernance = (
  props: StorageGovernanceDrawerProps,
  emit: StorageGovernanceDrawerEmits
) => {
  const inspecting = ref(false);
  const startingPrune = ref(false);
  const report = ref<NginxStorageInspectionReport | null>(null);
  const pruneJob = ref<StoragePruneJobSnapshot | null>(null);
  const inlineAction = ref<NonNullable<PruneNginxStorageBackupsPayload['inlineAction']>>('keep_latest_1');
  const applyRetentionPolicy = ref(true);
  const runCasGc = ref(true);
  const pruneConfirmOpen = ref(false);

  const orphanModalOpen = ref(false);
  const orphanLoading = ref(false);
  const orphanCleaning = ref(false);
  const orphanPreview = ref<OrphanAssetsPreviewResult | null>(null);
  const orphanMinAgeDays = ref(7);

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollGeneration = 0;

  const visible = computed({
    get: () => props.open,
    set: (val: boolean) => emit('update:open', val),
  });

  const apps = computed<StorageAppInspectionItem[]>(() => report.value?.apps || []);
  const summary = computed(() => report.value?.summary || null);
  const cleaning = computed(() => startingPrune.value || pruneJob.value?.status === 'running');
  const cleaningAll = computed(() => cleaning.value && pruneJob.value?.scope !== 'single');

  /** 计算全实例「一键安全瘦身」的影响预览摘要（含内嵌备份与三维保留策略预计裁剪数，仅计入本团队已纳管应用） */
  const pruneImpactSummary = computed<StoragePruneImpactSummary>(() => {
    let managedAppCount = 0;
    let skippedUnmanagedCount = 0;
    let skippedOtherTeamCount = 0;
    let estimatedInlineDeleteCount = 0;
    let estimatedInlineFreeBytes = 0;
    let estimatedRetentionDeleteCount = 0;
    let estimatedInvalidatedRollbackCount = 0;
    let migratedAppsClearingInline = 0;
    const nowSec = Math.floor(Date.now() / 1000);

    for (const app of apps.value) {
      if (app.ownership === 'managed_other_team' || app.otherTeamManaged) {
        skippedOtherTeamCount += 1;
        continue;
      }
      if (!app.managed) {
        skippedUnmanagedCount += 1;
        continue;
      }
      managedAppCount += 1;

      const deletedPaths = new Set<string>();
      const inlineBackups = (app.backups || [])
        .filter((b) => b.storageMode === 'inline')
        .sort((a, b) => b.createdAtEpoch - a.createdAtEpoch);

      if (inlineBackups.length > 0 && inlineAction.value !== 'none') {
        let toDelete = inlineBackups;
        if (inlineAction.value === 'keep_latest_1') {
          const startIdx = app.externalBackupCount > 0 ? 0 : 1;
          toDelete = inlineBackups.slice(startIdx);
          if (startIdx === 0 && toDelete.length > 0) {
            migratedAppsClearingInline += 1;
          }
        } else if (inlineAction.value === 'purge_unreferenced') {
          toDelete = inlineBackups.filter((b) => !b.referencedByDb);
        }
        estimatedInlineDeleteCount += toDelete.length;
        estimatedInlineFreeBytes += toDelete.reduce((sum, b) => sum + Number(b.physicalBytes || 0), 0);
        for (const b of toDelete) {
          deletedPaths.add(b.backupPath);
          if (b.referencedByDb) estimatedInvalidatedRollbackCount += 1;
        }
      }

      if (applyRetentionPolicy.value && app.retentionPolicy) {
        const policy = app.retentionPolicy;
        const remaining = (app.backups || [])
          .filter((b) => !deletedPaths.has(b.backupPath))
          .sort((a, b) => b.createdAtEpoch - a.createdAtEpoch);
        const minKeep = Math.max(1, Number(policy.minKeepCount || 1));
        const keepCount = Math.max(minKeep, Number(policy.backupKeepCount || 6));
        const ttlSec = Math.max(0, Number(policy.backupTtlDays || 0)) * 86400;
        let kept = 0;
        for (const b of remaining) {
          const ageSec = b.createdAtEpoch > 0 ? Math.max(0, nowSec - b.createdAtEpoch) : 0;
          const shouldPrune =
            kept >= minKeep && (kept >= keepCount || (ttlSec > 0 && ageSec > ttlSec));
          if (shouldPrune) {
            estimatedRetentionDeleteCount += 1;
            if (b.referencedByDb) estimatedInvalidatedRollbackCount += 1;
          } else {
            kept += 1;
          }
        }
      }
    }

    return {
      managedAppCount,
      skippedUnmanagedCount,
      skippedOtherTeamCount,
      estimatedInlineDeleteCount,
      estimatedInlineFreeBytes,
      estimatedRetentionDeleteCount,
      estimatedInvalidatedRollbackCount,
      migratedAppsClearingInline,
    };
  });

  /** 停止后台任务轮询定时器 */
  const stopPrunePolling = () => {
    pollGeneration += 1;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };

  /** 拉取当前实例存储诊断报告（纯只读扫描） */
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

  /** 打开全实例清理确认弹窗 */
  const openPruneConfirmModal = () => {
    if (cleaning.value || inspecting.value) return;
    pruneConfirmOpen.value = true;
  };

  /** 确认执行全实例一键安全瘦身 */
  const confirmPruneAllBackups = async () => {
    pruneConfirmOpen.value = false;
    await executePruneBackups();
  };

  /** 处理异步清理任务终态提示与列表刷新 */
  const handlePruneJobFinished = async (snapshot: StoragePruneJobSnapshot) => {
    if (snapshot.status === 'succeeded') {
      const gcDesc = snapshot.casGc && snapshot.casGc.deletedObjects > 0
        ? `，对象池回收 ${snapshot.casGc.deletedObjects} 个孤儿对象`
        : '';
      const dbDesc = snapshot.clearedDbRecords > 0
        ? `，同步更新 ${snapshot.clearedDbRecords} 条回滚记录`
        : '';
      message.success(
        `治理完成：删除 ${snapshot.deletedBackups} 份旧备份，释放约 ${formatStorageBytes(snapshot.freedBytes)}${gcDesc}${dbDesc}`
      );
      emit('cleaned');
      await loadInspection();
      return;
    }

    if (snapshot.status === 'cancelled') {
      const partialDesc = snapshot.deletedBackups > 0
        ? `（停止前已删 ${snapshot.deletedBackups} 份，释放约 ${formatStorageBytes(snapshot.freedBytes)}）`
        : '';
      message.info(`已停止存储清理${partialDesc}`);
      if (snapshot.deletedBackups > 0 || snapshot.clearedDbRecords > 0) {
        emit('cleaned');
        await loadInspection();
      }
      return;
    }

    if (snapshot.status === 'failed') {
      const partialDesc = snapshot.deletedBackups > 0
        ? `（中断前已删 ${snapshot.deletedBackups} 份并已同步更新回滚记录）`
        : '';
      message.error(`${snapshot.error || '执行备份清理失败'}${partialDesc}`);
      if (snapshot.deletedBackups > 0 || snapshot.clearedDbRecords > 0) {
        emit('cleaned');
        await loadInspection();
      }
    }
  };

  /** 轮询指定后台异步清理任务直至进入终态 */
  const startPrunePolling = (instanceId: number, jobId: string) => {
    stopPrunePolling();
    const myGen = pollGeneration;

    const tick = async () => {
      if (myGen !== pollGeneration) return;
      try {
        const snapshot = await getNginxStoragePruneJob(instanceId, jobId);
        if (myGen !== pollGeneration) return;
        pruneJob.value = snapshot;
        if (snapshot.status === 'running') {
          pollTimer = setTimeout(() => {
            void tick();
          }, PRUNE_POLL_INTERVAL_MS);
          return;
        }
        stopPrunePolling();
        await handlePruneJobFinished(snapshot);
      } catch (error: unknown) {
        if (myGen !== pollGeneration) return;
        stopPrunePolling();
        const errMsg = error instanceof Error ? error.message : '获取清理进度失败';
        message.error(errMsg);
      }
    };

    pollTimer = setTimeout(() => {
      void tick();
    }, PRUNE_POLL_INTERVAL_MS);
  };

  /** 重新打开抽屉时检测该实例是否有正在后台运行的清理任务并自动续接进度 */
  const resumeRunningPruneJobIfAny = async () => {
    const instanceId = props.instance?.id;
    if (!instanceId) return;
    try {
      const latest = await getLatestNginxStoragePruneJob(instanceId);
      if (props.instance?.id !== instanceId) return;
      if (latest && latest.status === 'running') {
        pruneJob.value = latest;
        startPrunePolling(instanceId, latest.jobId);
      } else if (!latest) {
        pruneJob.value = null;
      }
    } catch {
      // 忽略探活失败，不影响主扫描展示
    }
  };

  /** 启动全实例或指定目录的后台异步备份清理与对象池 GC */
  const executePruneBackups = async (override?: Partial<PruneNginxStorageBackupsPayload>) => {
    const instanceId = props.instance?.id;
    if (!instanceId || cleaning.value) return;
    startingPrune.value = true;
    try {
      const snapshot = await startNginxStoragePruneJob(instanceId, {
        inlineAction: inlineAction.value,
        applyRetentionPolicy: applyRetentionPolicy.value,
        runCasGc: runCasGc.value,
        ...override,
      });
      pruneJob.value = snapshot;
      if (snapshot.reused) {
        message.info('当前实例已有进行中的存储清理任务，已自动接入实时进度');
      }
      if (snapshot.status === 'running') {
        startPrunePolling(instanceId, snapshot.jobId);
      } else {
        await handlePruneJobFinished(snapshot);
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : '启动备份清理失败';
      message.error(errMsg);
    } finally {
      startingPrune.value = false;
    }
  };

  /** 停止当前正在运行的后台清理任务 */
  const cancelPruneBackups = async () => {
    const instanceId = props.instance?.id;
    const job = pruneJob.value;
    if (!instanceId || !job || job.status !== 'running' || job.cancelling) return;
    try {
      pruneJob.value = await cancelNginxStoragePruneJob(instanceId, job.jobId);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : '停止清理任务失败';
      message.error(errMsg);
    }
  };

  /** 收起已结束的进度横幅 */
  const dismissPruneBanner = () => {
    if (pruneJob.value?.status !== 'running') {
      pruneJob.value = null;
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

  /** 应用明细表操作列配置（单笔清理支持本行独立显示「清理中…」，且按需触发 CAS GC） */
  const actionConfig = computed<YTableActionConfig>(() => ({
    width: 215,
    fixed: 'right',
    displayLimit: 2,
    buttons: [
      {
        key: 'cleaningInline',
        text: '清理中…',
        type: 'link',
        hideFn: ({ row }: { row: StorageAppInspectionItem }) => !isRowMatchedByJob(row, pruneJob.value),
        disabledFn: () => true,
      },
      {
        key: 'cleanInline',
        text: '清理内嵌备份',
        type: 'link',
        isConfirm: true,
        confirmProps: {
          title: '确认清理该目录存量内嵌 .yuyan-backups？删除不可恢复；若已迁移外置仓，迁移前的旧回滚点将一并失效。',
          okText: '确认清理',
          cancelText: '取消',
        },
        hideFn: ({ row }: { row: StorageAppInspectionItem }) =>
          Boolean(row.otherTeamManaged || row.ownership === 'managed_other_team') ||
          isRowMatchedByJob(row, pruneJob.value) ||
          (row.inlineBackupCount <= 0 && row.inlineManifestBytes <= 0),
        disabledFn: () => cleaning.value,
        clickFn: async ({ row }: { row: StorageAppInspectionItem }) => {
          await executePruneBackups({
            inlineAction: 'keep_latest_1',
            applyRetentionPolicy: true,
            runCasGc: row.externalBackupCount > 0,
            targetRoots: row.deployRoot ? [row.deployRoot] : [row.key],
          });
        },
      },
      {
        key: 'scanOrphan',
        text: '扫描无主资源',
        type: 'link',
        hideFn: ({ row }: { row: StorageAppInspectionItem }) =>
          Boolean(row.otherTeamManaged || row.ownership === 'managed_other_team') || row.targetId <= 0,
        disabledFn: () => cleaning.value,
        clickFn: ({ row }: { row: StorageAppInspectionItem }) => {
          void openOrphanAssetsPreview(row, 7);
        },
      },
    ],
  }));

  watch(
    () => [props.open, props.instance?.id] as const,
    ([open, instanceId], prev) => {
      if (!open) {
        stopPrunePolling();
        return;
      }
      if (prev && prev[1] !== instanceId) {
        pruneJob.value = null;
      }
      if (instanceId) {
        void loadInspection();
        void resumeRunningPruneJobIfAny();
      }
    },
    { immediate: true }
  );

  onBeforeUnmount(() => {
    stopPrunePolling();
  });

  return {
    actionConfig,
    applyRetentionPolicy,
    apps,
    cancelPruneBackups,
    cleaning,
    cleaningAll,
    confirmCleanOrphanAssets,
    confirmPruneAllBackups,
    dismissPruneBanner,
    executePruneBackups,
    inlineAction,
    inspecting,
    loadInspection,
    openPruneConfirmModal,
    orphanCleaning,
    orphanLoading,
    orphanMinAgeDays,
    orphanModalOpen,
    orphanPreview,
    pruneConfirmOpen,
    pruneImpactSummary,
    pruneJob,
    reloadOrphanPreview,
    report,
    runCasGc,
    summary,
    visible,
  };
};
