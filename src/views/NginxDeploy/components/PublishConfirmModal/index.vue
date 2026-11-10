<script setup lang="ts">
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  ExclamationCircleOutlined,
  ExportOutlined,
  InfoCircleOutlined,
  RocketOutlined,
  StopOutlined,
  SyncOutlined,
  UserOutlined,
} from '@ant-design/icons-vue';
import { Modal } from 'ant-design-vue';
import { YButton } from '@yss-ui/components/lite';
import { YMonaco } from 'virtual:yss-heavy-components';
import { computed, h, ref, watch } from 'vue';
import { getTargetCleanupPreview, type DeployTarget, type DeployTargetCleanupPreview } from '@/api/deploy';
import type { PublishConfirmModalProps, PublishStartOptions } from './constant';
import { usePublishConfirm } from './hooks/usePublishConfirm';
import {
  groupCleanupPreviewItems,
  canStartPublishWithCleanup,
  isSharedDeployRoot,
  formatShortCleanupSummary,
  formatCleanupSummaryTooltip,
  getPublishConfirmPopupTitle,
  formatPublishConfirmPopupBody,
  needsPublishConfirmation,
  canDirectlyPublish,
  resolvePublishGate,
  buildPublishStartPayload,
} from './cleanupPreviewPolicy';
import DeployLogLegend from '../DeployLogLegend/index.vue';
import SshFailureGuideCard from '../SshFailureGuideCard/index.vue';
import type { SshFailureAction } from '../../sshFailureGuide';

defineOptions({ name: 'PublishConfirmModal' });

const props = defineProps<PublishConfirmModalProps>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'start', value: PublishStartOptions): void;
  (e: 'republish', value: PublishStartOptions): void;
  (e: 'stop'): void;
  (e: 'verify-result'): void;
  (e: 'view-record', target: DeployTarget): void;
  (e: 'ssh-action', action: SshFailureAction): void;
}>();

/** 是否强制重新安装依赖 */
const forceInstallDependencies = ref(false);

/** 目录清理预览加载中 */
const previewLoading = ref(false);
/** 目录清理预览错误信息 */
const previewError = ref<string | null>(null);
/** 目录清理预览数据 */
const previewData = ref<DeployTargetCleanupPreview | null>(null);
/** 用户主动勾选的额外清理项（未识别项） */
const extraCleanupNames = ref<string[]>([]);
/** 清空后替换二次确认状态 */
const cleanReplaceConfirmed = ref(false);

/** 是否为清空后替换模式（仅前端项目生效） */
const isCleanReplace = computed(() =>
  Boolean(props.target?.projectType !== 'backend' && props.target?.uploadStrategy === 'cleanReplace')
);

/** 是否为共享根目录 */
const isSharedRoot = computed(() => {
  if (previewData.value?.isSharedRoot !== undefined) {
    return previewData.value.isSharedRoot;
  }
  return isSharedDeployRoot({ target: props.target });
});

/** 整理后的清理预览条目 */
const groupedPreview = computed(() => groupCleanupPreviewItems(previewData.value));

/** 用户是否勾选了额外清理项 */
const hasSelectedExtra = computed(() => extraCleanupNames.value.length > 0);

/** 明细折叠是否展开，默认收起 */
const detailExpanded = ref(false);

/** 确认气泡显隐控制 */
const startConfirmOpen = ref(false);
const republishConfirmOpen = ref(false);

/** 是否与上次确认一致（加载失败时按不一致处理） */
const isMatchesConfirmed = computed(() => {
  if (previewError.value) return false;
  return Boolean(previewData.value?.matchesConfirmed);
});

/** 摘要短文本：清空后替换 · 替换 N 项（一致时显示：清空后替换 · 替换 N 项 · 与上次确认一致） */
const shortCleanupSummaryText = computed(() =>
  formatShortCleanupSummary({
    replaceCount: groupedPreview.value.replaceOrCleanItems.length,
    matchesConfirmed: isMatchesConfirmed.value,
  })
);

/** 摘要 ⓘ 完整说明 Tooltip */
const cleanupSummaryTooltipText = computed(() => {
  const nestedCount = groupedPreview.value.protectedItems.filter((i) => i.source === 'nested').length;
  const manualCount = groupedPreview.value.protectedItems.filter((i) => i.source === 'manual').length;
  return formatCleanupSummaryTooltip({
    isSharedRoot: isSharedRoot.value,
    replaceCount: groupedPreview.value.replaceOrCleanItems.length,
    nestedCount,
    manualCount,
    unknownCount: groupedPreview.value.unknownItems.length,
    extraCleanupCount: extraCleanupNames.value.length,
    matchesConfirmed: isMatchesConfirmed.value,
    lastConfirmedAt: previewData.value?.lastConfirmedAt,
    lastConfirmedBy: previewData.value?.lastConfirmedBy,
  });
});

/** 气泡标题与正文 */
const confirmPopupTitle = computed(() =>
  getPublishConfirmPopupTitle({
    isSharedRoot: isSharedRoot.value,
    hasSelectedExtra: hasSelectedExtra.value,
  })
);

const confirmPopupBody = computed(() => {
  const nestedCount = groupedPreview.value.protectedItems.filter((i) => i.source === 'nested').length;
  const manualCount = groupedPreview.value.protectedItems.filter((i) => i.source === 'manual').length;
  return formatPublishConfirmPopupBody({
    isSharedRoot: isSharedRoot.value,
    replaceCount: groupedPreview.value.replaceOrCleanItems.length,
    nestedCount,
    manualCount,
    unknownCount: groupedPreview.value.unknownItems.length,
    extraCleanupCount: extraCleanupNames.value.length,
    scopeDiff: previewData.value?.scopeDiff,
  });
});

/** 明细三组是否均为空 */
const allGroupsEmpty = computed(
  () =>
    groupedPreview.value.replaceOrCleanItems.length === 0 &&
    groupedPreview.value.protectedItems.length === 0 &&
    groupedPreview.value.unknownItems.length === 0
);

const normalizeDeployPath = (rawPath?: string | null): string => {
  if (!rawPath) return '';
  const trimmed = rawPath.trim().replace(/\\/g, '/');
  if (!trimmed) return '';
  const collapsed = trimmed.replace(/\/+/g, '/');
  return collapsed.length > 1 && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
};

/** 部署根是否为软链接 */
const isSymlinkRoot = computed(() => {
  if (!previewData.value?.realRoot) return false;
  const configured = previewData.value.configuredRoot || props.target?.deployRoot || '';
  const normalizedReal = normalizeDeployPath(previewData.value.realRoot);
  const normalizedConfigured = normalizeDeployPath(configured);
  return Boolean(normalizedConfigured && normalizedReal && normalizedReal !== normalizedConfigured);
});

/** 加载目录清理预览 */
const loadPreview = async () => {
  if (!props.target?.id || !isCleanReplace.value) return;
  previewLoading.value = true;
  previewError.value = null;
  try {
    const data = await getTargetCleanupPreview(props.target.id);
    previewData.value = data;
  } catch (err: any) {
    previewError.value = err?.message || '无法获取远程目录清理预览，请检查服务器网络或 SSH 连接配置';
  } finally {
    previewLoading.value = false;
  }
};

/** 开始发布按钮是否允许点击 */
const canClickStartButton = computed(() => {
  if (!props.target || props.centralUnavailable || props.resultUnconfirmed) return false;
  if (!isCleanReplace.value) return true;
  if (previewData.value?.riskLevel === 'block') return false;
  if (previewLoading.value) return false;
  if (previewError.value && isSharedRoot.value) return false;
  return true;
});

/** 业务逻辑 Hook */
const {
  logMonacoRef,
  finished,
  hasError,
  errorSummary,
  jumpToErrorLine,
  isSuccessFinished,
  hasValidVisitUrl,
  successDurationText,
  successVersionText,
  openSite,
  copySiteUrl,
  visibleStages,
  headerDescription,
  statusText,
  statusClassName,
  targetSummaries,
  displayOperator,
  isSelfOperator,
  operatorTagText,
  isSubscriberMode,
  canStop,
  canPreempt,
  stopButtonText,
  stopButtonTooltip,
  lockDescription,
  publishLogContent,
  getStageStatus,
  getStageLabel,
} = usePublishConfirm(props);

/** 查看本条发布记录 */
const handleViewRecord = () => {
  visible.value = false;
  if (props.target) {
    emit('view-record', props.target);
  }
};

/** 弹窗显隐状态 */
const visible = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
});

/** 点击「开始发布」按钮触发门禁判定 */
const onStartButtonClick = () => {
  const gate = resolvePublishGate({
    isCleanReplace: isCleanReplace.value,
    isSharedRoot: isSharedRoot.value,
    hasSelectedExtra: hasSelectedExtra.value,
    matchesConfirmed: isMatchesConfirmed.value,
    confirmed: false,
  });

  if (!gate.needConfirm) {
    handleStart();
    return;
  }
  startConfirmOpen.value = true;
};

/**
 * 气泡只允许由门禁打开：忽略 Trigger 点击按钮时自带的 open=true，只接受点外部等关闭事件。
 * @param value Popover 请求的显隐值
 */
const onStartConfirmOpenChange = (value: boolean) => {
  if (!value) startConfirmOpen.value = false;
};
const onRepublishConfirmOpenChange = (value: boolean) => {
  if (!value) republishConfirmOpen.value = false;
};

/** 气泡挂在按钮所在的 footer 内，抽屉关闭时随之隐藏，不会漂到窗口左上角 */
const getConfirmPopupContainer = (triggerNode?: HTMLElement) => triggerNode?.parentElement || document.body;

/** 点击「重新发布」按钮触发门禁判定 */
const onRepublishButtonClick = () => {
  const gate = resolvePublishGate({
    isCleanReplace: isCleanReplace.value,
    isSharedRoot: isSharedRoot.value,
    hasSelectedExtra: hasSelectedExtra.value,
    matchesConfirmed: isMatchesConfirmed.value,
    confirmed: false,
  });

  if (!gate.needConfirm) {
    handleRepublish();
    return;
  }
  republishConfirmOpen.value = true;
};

/** 气泡内点击「查看明细」：展开明细并关闭气泡 */
const handleConfirmViewDetail = () => {
  detailExpanded.value = true;
  startConfirmOpen.value = false;
  republishConfirmOpen.value = false;
};

/** 气泡内点击「确认发布」 */
const handleConfirmPublish = () => {
  startConfirmOpen.value = false;
  handleStart({ confirmed: true });
};

/** 气泡内点击「确认重新发布」 */
const handleConfirmRepublish = () => {
  republishConfirmOpen.value = false;
  handleRepublish({ confirmed: true });
};

/**
 * 真正执行开始发布。
 * 必须经过 resolvePublishGate 守门，若需要确认但未 confirmed 则不可绕过，强制阻断并弹气泡。
 */
const handleStart = (options?: { confirmed?: boolean } | MouseEvent) => {
  const confirmed = options && 'confirmed' in options ? Boolean(options.confirmed) : false;
  const gate = resolvePublishGate({
    isCleanReplace: isCleanReplace.value,
    isSharedRoot: isSharedRoot.value,
    hasSelectedExtra: hasSelectedExtra.value,
    matchesConfirmed: isMatchesConfirmed.value,
    confirmed,
  });

  if (!gate.canPublish) {
    startConfirmOpen.value = true;
    return;
  }

  emit(
    'start',
    buildPublishStartPayload({
      forceInstallDependencies: forceInstallDependencies.value,
      extraCleanupNames: extraCleanupNames.value,
      scopeFingerprint: previewData.value?.scopeFingerprint,
      confirmed,
    })
  );
};

/**
 * 真正执行重新发布。
 * 必须经过 resolvePublishGate 守门，若需要确认但未 confirmed 则不可绕过，强制阻断并弹气泡。
 */
const handleRepublish = (options?: { confirmed?: boolean } | MouseEvent) => {
  const confirmed = options && 'confirmed' in options ? Boolean(options.confirmed) : false;
  const gate = resolvePublishGate({
    isCleanReplace: isCleanReplace.value,
    isSharedRoot: isSharedRoot.value,
    hasSelectedExtra: hasSelectedExtra.value,
    matchesConfirmed: isMatchesConfirmed.value,
    confirmed,
  });

  if (!gate.canPublish) {
    republishConfirmOpen.value = true;
    return;
  }

  extraCleanupNames.value = [];
  emit(
    'republish',
    buildPublishStartPayload({
      forceInstallDependencies: forceInstallDependencies.value,
      extraCleanupNames: [],
      scopeFingerprint: previewData.value?.scopeFingerprint,
      confirmed,
    })
  );
};

/** 处理停止发布或管理员强制停止点击 */
const handleStopClick = () => {
  if (canPreempt.value) {
    Modal.confirm({
      title: '确认强制停止他人任务？',
      icon: h(ExclamationCircleOutlined),
      content: `当前发布任务正由「${displayOperator.value}」执行中，作为管理员强制停止将终止其发布流程。是否确认继续？`,
      okText: '强制停止',
      okType: 'danger',
      cancelText: '取消',
      onOk: () => emit('stop'),
    });
    return;
  }
  emit('stop');
};

/** 抽屉开关、发布开始/结束时收起确认气泡，避免状态残留后重新挂载时自动弹出 */
watch(
  () => [props.open, props.started, props.running],
  () => {
    startConfirmOpen.value = false;
    republishConfirmOpen.value = false;
  }
);

watch(
  () => [props.open, props.target?.id],
  ([open]) => {
    if (open && !props.started) {
      forceInstallDependencies.value = false;
      extraCleanupNames.value = [];
      cleanReplaceConfirmed.value = false;
      detailExpanded.value = false;
      startConfirmOpen.value = false;
      republishConfirmOpen.value = false;
      if (isCleanReplace.value) {
        void loadPreview();
      } else {
        previewData.value = null;
        previewError.value = null;
      }
    }
  },
  { immediate: true }
);
</script>

<template>
  <a-drawer
    v-model:open="visible"
    width="min(960px, calc(100vw - 48px))"
    placement="right"
    rootClassName="publish-workbench-drawer-root"
    class="publish-workbench-drawer"
    :bodyStyle="{ padding: '0' }"
  >
    <template #title>
      <div class="publish-workbench__header">
        <div class="publish-workbench__header-left">
          <h3 class="publish-workbench__title">
            <span class="publish-workbench__tag">{{ started ? '实时发布' : '发布前确认' }}</span>
            <span class="publish-workbench__title-text">{{ started ? title || '发布处理中' : `确认发布到${target?.envName || '测试'}环境` }}</span>
            <a-tag
              class="publish-operator-tag"
              :class="{ 'is-self': isSelfOperator, 'is-pending': !started }"
              :color="!started ? 'default' : isSelfOperator ? 'blue' : 'purple'"
            >
              <template #icon><UserOutlined /></template>
              {{ operatorTagText }}
            </a-tag>
          </h3>
          <p class="publish-workbench__desc">{{ headerDescription }}</p>
        </div>
        <div class="publish-workbench__status" :class="statusClassName">
          <strong>{{ percent }}%</strong>
          <span>{{ statusText }}</span>
        </div>
      </div>
    </template>

    <section class="publish-workbench" :class="{ 'is-started': started }">

      <div v-if="isSubscriberMode" class="publish-subscriber-banner">
        <span class="publish-subscriber-banner__icon">
          <InfoCircleOutlined />
        </span>
        <span class="publish-subscriber-banner__text">
          <strong>协同观察模式：</strong>{{ lockDescription }}
        </span>
      </div>

      <div class="publish-target-mini">
        <div v-for="item in targetSummaries" :key="item.label" class="publish-target-mini__item">
          <span>{{ item.label }}</span>
          <strong>{{ item.value }}</strong>
        </div>
      </div>

      <!-- 软链接与高危风险安全提示 -->
      <template v-if="!started && isCleanReplace && previewData">
        <a-alert
          v-if="isSymlinkRoot"
          type="info"
          show-icon
          class="publish-cleanup-notice"
          :message="`部署目录是软链接，实际操作的目录是 ${previewData.realRoot}`"
        />
        <a-alert
          v-if="previewData.riskLevel === 'block'"
          type="error"
          show-icon
          class="publish-cleanup-notice"
          message="部署根目录属于系统高危路径，发布已被禁止"
          :description="previewData.riskReason"
        />
        <a-alert
          v-else-if="previewData.riskLevel === 'warn'"
          type="warning"
          show-icon
          class="publish-cleanup-notice"
          message="部署根目录安全提示"
          :description="previewData.riskReason || '该部署根属于常见浅层目录，请格外仔细核对下方列表。'"
        />
      </template>

      <!-- 精简后的清空后替换目录清理预览行 -->
      <section v-if="!started && isCleanReplace" class="publish-cleanup-bar">
        <!-- 1. 加载中（简洁一行） -->
        <div v-if="previewLoading" class="publish-cleanup-bar__loading">
          <SyncOutlined spin class="publish-cleanup-bar__loading-icon" />
          <span>正在读取服务器目录清理预览…</span>
        </div>

        <!-- 2. 出错状态（简洁一行） -->
        <div v-else-if="previewError" class="publish-cleanup-bar__error">
          <CloseCircleOutlined class="publish-cleanup-bar__error-icon" />
          <span class="publish-cleanup-bar__error-text">{{ previewError }}</span>
          <a-button type="link" size="small" class="publish-cleanup-bar__retry-btn" @click="loadPreview">
            重试
          </a-button>
        </div>

        <!-- 3. 数据就绪状态（简洁一行：文本 + ⓘ + 明细链接 + 刷新图标） -->
        <div v-else-if="previewData" class="publish-cleanup-bar__content">
          <div class="publish-cleanup-bar__summary">
            <span class="publish-cleanup-bar__text">{{ shortCleanupSummaryText }}</span>
            <a-tooltip :title="cleanupSummaryTooltipText">
              <InfoCircleOutlined class="publish-cleanup-bar__info-icon" />
            </a-tooltip>
            <a-button
              type="link"
              size="small"
              class="publish-cleanup-bar__detail-btn"
              @click="detailExpanded = !detailExpanded"
            >
              {{ detailExpanded ? '收起明细' : '明细' }}
            </a-button>
            <a-tooltip title="刷新预览">
              <a-button
                type="text"
                size="small"
                class="publish-cleanup-bar__refresh-btn"
                :loading="previewLoading"
                @click="loadPreview"
              >
                <template #icon><SyncOutlined /></template>
              </a-button>
            </a-tooltip>
          </div>

          <!-- 明细折叠面板（某组为 0 时不显示该组） -->
          <div v-if="detailExpanded" class="publish-cleanup-detail">
            <!-- 1. 待替换/清理项（为 0 时不显示） -->
            <div
              v-if="groupedPreview.replaceOrCleanItems.length > 0"
              class="publish-cleanup-detail__group is-replace"
            >
              <div class="publish-cleanup-detail__group-head">
                <DeleteOutlined class="group-icon text-danger" />
                <strong>待替换/清理项 ({{ groupedPreview.replaceOrCleanItems.length }})</strong>
                <span class="group-desc">本次发布将替换这些文件/目录</span>
              </div>
              <div class="publish-cleanup-detail__tags">
                <a-tag v-for="item in groupedPreview.replaceOrCleanItems" :key="item" color="red">
                  {{ item }}
                </a-tag>
              </div>
            </div>

            <!-- 2. 受保护项（为 0 时不显示） -->
            <div
              v-if="groupedPreview.protectedItems.length > 0"
              class="publish-cleanup-detail__group is-protected"
            >
              <div class="publish-cleanup-detail__group-head">
                <CheckCircleOutlined class="group-icon text-success" />
                <strong>受保护项 ({{ groupedPreview.protectedItems.length }})</strong>
                <span class="group-desc">同服务器已登记的子应用与保留项，本次发布完整保留</span>
              </div>
              <div class="publish-cleanup-detail__tags">
                <a-tooltip
                  v-for="item in groupedPreview.protectedItems"
                  :key="item.name"
                  :title="item.reason"
                >
                  <a-tag color="green">
                    {{ item.name }} ({{ item.source === 'nested' ? '已登记子应用' : '手填保留' }})
                  </a-tag>
                </a-tooltip>
              </div>
            </div>

            <!-- 3. 未识别项（为 0 时不显示） -->
            <div
              v-if="groupedPreview.unknownItems.length > 0"
              class="publish-cleanup-detail__group is-unknown"
            >
              <div class="publish-cleanup-detail__group-head">
                <InfoCircleOutlined class="group-icon text-warning" />
                <strong>未识别项 ({{ groupedPreview.unknownItems.length }})</strong>
                <span class="group-desc">默认保留。勾选可加入本次额外清理：</span>
              </div>
              <div class="publish-cleanup-detail__unknown-list">
                <a-checkbox-group v-model:value="extraCleanupNames" class="publish-unknown-checkbox-group">
                  <a-checkbox
                    v-for="item in groupedPreview.unknownItems"
                    :key="item"
                    :value="item"
                    class="publish-unknown-item"
                  >
                    <span class="publish-unknown-name">{{ item }}</span>
                  </a-checkbox>
                </a-checkbox-group>
              </div>
            </div>

            <!-- 三组均为空兜底 -->
            <div v-if="allGroupsEmpty" class="publish-cleanup-detail__empty">
              当前没有待替换、受保护或未识别的文件项
            </div>
          </div>
        </div>
      </section>

      <section class="publish-flow-panel">
        <div class="publish-flow-panel__head">
          <h4>{{ started ? '实时发布节点' : '发布节点预览' }}</h4>
          <a-tag :color="stopped ? 'default' : hasError ? 'error' : finished ? 'success' : started ? 'processing' : 'blue'" class="auto-exec-tag">
            {{ stopped ? '已停止' : started ? title || '准备发布' : '开始后自动执行' }}
          </a-tag>
        </div>
        <div class="publish-stage-rail" role="list" aria-label="发布节点">
          <article v-for="(stage, index) in visibleStages" :key="stage.key" class="publish-stage-marker" :class="`is-${getStageStatus(stage)}`" role="listitem">
            <div class="publish-stage-track">
              <span class="publish-stage-node">
                <CheckCircleOutlined v-if="getStageStatus(stage) === 'finish'" />
                <SyncOutlined v-else-if="getStageStatus(stage) === 'process'" />
                <CloseCircleOutlined v-else-if="getStageStatus(stage) === 'error'" />
                <StopOutlined v-else-if="getStageStatus(stage) === 'stopped'" />
                <ClockCircleOutlined v-else />
              </span>
              <span v-if="index < visibleStages.length - 1" class="publish-stage-link" />
            </div>
            <div class="publish-stage-label">{{ getStageLabel(stage) }}</div>
          </article>
        </div>
      </section>

      <div v-if="isSuccessFinished" class="publish-success-banner">
        <div class="publish-success-banner__icon">
          <CheckCircleOutlined />
        </div>
        <div class="publish-success-banner__content">
          <div class="publish-success-banner__title">发布成功，站点已就绪！</div>
          <div class="publish-success-banner__meta">
            <span>环境：<strong>{{ target?.envName || '测试' }}</strong></span>
            <span v-if="successVersionText">分支：<strong>{{ successVersionText }}</strong></span>
            <span v-if="successDurationText">耗时：<strong>{{ successDurationText }}</strong></span>
            <span>操作人：<strong>{{ displayOperator }}</strong></span>
          </div>
        </div>
      </div>

      <SshFailureGuideCard
        v-if="started && !running && sshFailure"
        class="publish-ssh-guide"
        :failure="sshFailure"
        @action="(action) => emit('ssh-action', action)"
      />

      <section v-if="started" class="publish-log-panel">
        <div class="publish-log-panel__head">
          <h4>发布日志</h4>
          <a-space :size="8">
            <a-tag v-if="hasError" color="error">失败详情见日志</a-tag>
            <a-button
              v-if="hasError && errorSummary"
              size="small"
              danger
              type="link"
              class="publish-log-jump-btn"
              @click="jumpToErrorLine"
            >
              🚨 定位至错误诊断
            </a-button>
            <span>{{ logs.length }} 条</span>
          </a-space>
        </div>
        <DeployLogLegend />
        <YMonaco
          ref="logMonacoRef"
          class="publish-log-monaco"
          :model-value="publishLogContent"
          language="log"
          theme="vs-dark"
          height="100%"
          :readonly="true"
          log-mode
          :max-lines="20000"
          :auto-scroll="true"
          :show-border="false"
          :options="{
            minimap: { enabled: false },
            fontSize: 13,
            wordWrap: 'on',
            readOnly: true,
            folding: false,
            guides: { indentation: false },
          }"
        />
      </section>
    </section>

    <template #footer>
      <footer class="publish-workbench__footer">
        <div v-if="!running" class="publish-footer-left">
          <a-checkbox v-model:checked="forceInstallDependencies">
            本次重新安装依赖
          </a-checkbox>
          <a-tooltip title="依赖缓存异常时使用，会清理旧 node_modules 后重新安装。">
            <InfoCircleOutlined class="publish-footer-hint-icon" />
          </a-tooltip>
        </div>
        <div v-else class="publish-footer-left" />

        <div class="publish-workbench__actions">
          <span v-if="centralUnavailable">中央服务恢复后可继续发布</span>
          <YButton v-if="resultUnconfirmed && canVerifyResult" :loading="verifyingResult" @click="emit('verify-result')">
            核实任务结果
          </YButton>
          <template v-if="isSuccessFinished">
            <YButton @click="visible = false">关闭</YButton>
            <YButton v-if="hasValidVisitUrl" @click="copySiteUrl">
              <template #icon><CopyOutlined /></template>
              复制地址
            </YButton>
            <YButton :type="hasValidVisitUrl ? 'default' : 'primary'" @click="handleViewRecord">
              查看发布记录
            </YButton>
            <YButton v-if="hasValidVisitUrl" type="primary" @click="openSite">
              <template #icon><ExportOutlined /></template>
              打开站点
            </YButton>
            <YButton :disabled="centralUnavailable || resultUnconfirmed" @click="handleRepublish">
              <template #icon><SyncOutlined /></template>
              重新发布
            </YButton>
          </template>
          <template v-else>
            <YButton @click="visible = false">{{ started && running ? '收起' : started ? '关闭' : '取消' }}</YButton>
            <a-tooltip :title="stopButtonTooltip">
              <YButton
                v-if="started && running"
                danger
                :disabled="!canStop"
                :loading="stopping"
                @click="handleStopClick"
              >
                <template #icon><StopOutlined /></template>
                {{ stopButtonText }}
              </YButton>
            </a-tooltip>

            <!-- 开始发布 Popover 气泡确认 -->
            <a-popover
              v-if="!started"
              :open="startConfirmOpen"
              trigger="click"
              :getPopupContainer="getConfirmPopupContainer"
              @openChange="onStartConfirmOpenChange"
              placement="topRight"
              overlayClassName="publish-confirm-popover"
            >
              <template #title>
                <div class="publish-confirm-popover__title">
                  <ExclamationCircleOutlined class="publish-confirm-popover__icon" />
                  <span>{{ confirmPopupTitle }}</span>
                </div>
              </template>
              <template #content>
                <div class="publish-confirm-popover__content">
                  <p class="publish-confirm-popover__body">{{ confirmPopupBody }}</p>
                  <div class="publish-confirm-popover__actions">
                    <a-button size="small" class="publish-confirm-popover__btn" @click="handleConfirmViewDetail">
                      查看明细
                    </a-button>
                    <a-button size="small" class="publish-confirm-popover__btn" @click="startConfirmOpen = false">
                      取消
                    </a-button>
                    <a-button size="small" type="primary" class="publish-confirm-popover__btn" @click="handleConfirmPublish">
                      确认发布
                    </a-button>
                  </div>
                </div>
              </template>
              <YButton
                type="primary"
                :disabled="!canClickStartButton"
                @click="onStartButtonClick"
              >
                <template #icon><RocketOutlined /></template>
                开始发布
              </YButton>
            </a-popover>

            <!-- 重新发布 Popover 气泡确认 -->
            <a-popover
              v-if="started && !running"
              :open="republishConfirmOpen"
              trigger="click"
              :getPopupContainer="getConfirmPopupContainer"
              @openChange="onRepublishConfirmOpenChange"
              placement="topRight"
              overlayClassName="publish-confirm-popover"
            >
              <template #title>
                <div class="publish-confirm-popover__title">
                  <ExclamationCircleOutlined class="publish-confirm-popover__icon" />
                  <span>{{ confirmPopupTitle }}</span>
                </div>
              </template>
              <template #content>
                <div class="publish-confirm-popover__content">
                  <p class="publish-confirm-popover__body">{{ confirmPopupBody }}</p>
                  <div class="publish-confirm-popover__actions">
                    <a-button size="small" class="publish-confirm-popover__btn" @click="handleConfirmViewDetail">
                      查看明细
                    </a-button>
                    <a-button size="small" class="publish-confirm-popover__btn" @click="republishConfirmOpen = false">
                      取消
                    </a-button>
                    <a-button size="small" type="primary" class="publish-confirm-popover__btn" @click="handleConfirmRepublish">
                      确认发布
                    </a-button>
                  </div>
                </div>
              </template>
              <YButton
                type="primary"
                :disabled="!canClickStartButton"
                @click="onRepublishButtonClick"
              >
                <template #icon><SyncOutlined /></template>
                重新发布
              </YButton>
            </a-popover>
          </template>
        </div>
      </footer>
    </template>
  </a-drawer>
</template>

<style scoped lang="less">
@import './style.less';
</style>
