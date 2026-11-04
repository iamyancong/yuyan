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
import { groupCleanupPreviewItems, canStartPublishWithCleanup, isSharedDeployRoot } from './cleanupPreviewPolicy';
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

/** 是否需要展示二次确认复选框（共享根或勾选了额外清理项时） */
const needSecondaryConfirm = computed(() =>
  Boolean(isCleanReplace.value && (isSharedRoot.value || hasSelectedExtra.value))
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

/** 开始发布按钮是否可用 */
const canStartPublish = computed(() => {
  if (!props.target || props.centralUnavailable || props.resultUnconfirmed) return false;
  return canStartPublishWithCleanup({
    isCleanReplace: isCleanReplace.value,
    isSharedRoot: isSharedRoot.value,
    cleanReplaceConfirmed: cleanReplaceConfirmed.value,
    hasSelectedExtra: hasSelectedExtra.value,
    previewLoading: previewLoading.value,
    previewError: Boolean(previewError.value),
    riskLevel: previewData.value?.riskLevel || 'ok',
  });
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

/** 开始发布 */
const handleStart = () => {
  emit('start', {
    forceInstallDependencies: forceInstallDependencies.value,
    extraCleanupNames: extraCleanupNames.value,
    cleanReplaceConfirmed: cleanReplaceConfirmed.value,
  });
};

/** 重新发布 */
const handleRepublish = () => {
  extraCleanupNames.value = [];
  emit('republish', {
    forceInstallDependencies: forceInstallDependencies.value,
    extraCleanupNames: [],
    cleanReplaceConfirmed: cleanReplaceConfirmed.value,
  });
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

watch(
  () => [props.open, props.target?.id],
  ([open]) => {
    if (open && !props.started) {
      forceInstallDependencies.value = false;
      extraCleanupNames.value = [];
      cleanReplaceConfirmed.value = false;
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

      <!-- 清空后替换目录清理安全预览 -->
      <section v-if="!started && isCleanReplace" class="publish-cleanup-section">
        <div class="publish-cleanup-section__head">
          <div class="publish-cleanup-section__title">
            <DeleteOutlined />
            <span>清空后替换：目录清理预览</span>
          </div>
          <a-button
            size="small"
            type="link"
            :loading="previewLoading"
            @click="loadPreview"
          >
            <template #icon><SyncOutlined /></template>
            刷新预览
          </a-button>
        </div>

        <div v-if="previewLoading" class="publish-cleanup-loading">
          <a-spin tip="正在读取服务器上的目录和上次发布清单…" />
        </div>

        <div v-else-if="previewError" class="publish-cleanup-error">
          <a-alert
            :type="isSharedRoot ? 'error' : 'warning'"
            show-icon
            :message="isSharedRoot ? '获取删除预览失败' : '无法获取远程目录清理预览'"
          >
            <template #description>
              <div>{{ previewError }}</div>
              <div v-if="isSharedRoot" class="publish-cleanup-error__hint">
                这个目录是多个应用共用的，必须先看到删除预览才能发布。请检查服务器连接后重试。
              </div>
              <div v-else class="publish-cleanup-error__hint">
                拿不到预览也可以发布，发布时只会删除本次产物里的同名项和上次发布过的项。
              </div>
              <div style="margin-top: 8px">
                <a-button size="small" type="primary" ghost @click="loadPreview">重试探测</a-button>
              </div>
            </template>
          </a-alert>
        </div>

        <div v-else-if="previewData" class="publish-cleanup-content">
          <!-- 软链接路径提示 -->
          <a-alert
            v-if="isSymlinkRoot"
            type="info"
            show-icon
            class="publish-cleanup-notice"
            :message="`部署目录是软链接，实际操作的目录是 ${previewData.realRoot}`"
          />

          <!-- 风险警告提示 -->
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

          <!-- 共享根目录风险提示 -->
          <a-alert
            v-if="previewData.isSharedRoot"
            type="warning"
            show-icon
            class="publish-cleanup-notice"
            message="检测到共享根目录"
            description="当前目录由多个部署目标或应用共用。清空操作仅清理雨燕记录的已知文件，不会删除未在清单中的其他应用或手放文件。"
          />

          <!-- 没有找到上次发布清单提示 -->
          <a-alert
            v-if="!previewData.manifestFound"
            type="info"
            show-icon
            class="publish-cleanup-notice"
            message="没找到上次发布清单（老目标第一次按新规则发布时常见）。这次只替换产物里出现的同名项，其余全部保留。"
          />

          <!-- 三组分类清晰展示 -->
          <div class="publish-cleanup-groups">
            <!-- 1. 待替换/清理项 -->
            <div class="publish-cleanup-group is-replace">
              <div class="publish-cleanup-group__title">
                <DeleteOutlined class="group-icon text-danger" />
                <strong>待替换/清理项 ({{ groupedPreview.replaceOrCleanItems.length }})</strong>
                <span class="group-desc">本次发布将替换或删除这些雨燕此前发布过的文件/目录</span>
              </div>
              <div v-if="groupedPreview.replaceOrCleanItems.length" class="publish-cleanup-tags">
                <a-tag v-for="item in groupedPreview.replaceOrCleanItems" :key="item" color="red">
                  {{ item }}
                </a-tag>
              </div>
              <div v-else class="publish-cleanup-empty">
                {{ previewData.manifestFound ? '当前部署根下无上次发布的残留条目' : '没有找到上次发布清单，本次仅清理产物里出现的同名项' }}
              </div>
            </div>

            <!-- 2. 受保护项 -->
            <div class="publish-cleanup-group is-protected">
              <div class="publish-cleanup-group__title">
                <CheckCircleOutlined class="group-icon text-success" />
                <strong>受保护项 ({{ groupedPreview.protectedItems.length }})</strong>
                <span class="group-desc">同服务器已登记的子应用与手动配置的保留项，本次发布将完整保留</span>
              </div>
              <div v-if="groupedPreview.protectedItems.length" class="publish-cleanup-tags">
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
              <div v-else class="publish-cleanup-empty">暂无受保护项</div>
            </div>

            <!-- 3. 未识别项 -->
            <div class="publish-cleanup-group is-unknown">
              <div class="publish-cleanup-group__title">
                <InfoCircleOutlined class="group-icon text-warning" />
                <strong>未识别项 ({{ groupedPreview.unknownItems.length }})</strong>
                <span class="group-desc">这些不在雨燕上次发布的清单里，默认保留。注意：如果本次构建产物里有同名的顶层文件或目录，它们会被新版本替换。</span>
              </div>
              <div v-if="groupedPreview.unknownItems.length" class="publish-cleanup-unknown-list">
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
              <div v-else class="publish-cleanup-empty">没有检测到未识别文件</div>
            </div>

            <!-- 系统保留项弱化提示 -->
            <div class="publish-cleanup-reserved-note">
              <span class="text-secondary">提示：系统目录 .yuyan-backups、.yuyan-manifests 永远不会被删除。</span>
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
        <div v-if="!running && !started && needSecondaryConfirm" class="publish-secondary-confirm-bar">
          <a-checkbox v-model:checked="cleanReplaceConfirmed">
            <span class="publish-secondary-confirm-bar__label">
              我已核对上述待清理和保留列表，确认执行清空后替换
            </span>
          </a-checkbox>
          <div v-if="isSharedRoot" class="publish-secondary-confirm-bar__hint">
            当前目录是多应用共用的共享根目录，必须核对列表并勾选确认后方可发布。
          </div>
          <div v-else-if="hasSelectedExtra" class="publish-secondary-confirm-bar__hint">
            您勾选了额外清理项，必须勾选确认后方可执行发布。
          </div>
        </div>
        <div v-if="!running" class="publish-cache-option">
          <a-checkbox v-model:checked="forceInstallDependencies">本次重新安装依赖</a-checkbox>
          <span>依赖缓存异常时使用，会清理旧 node_modules 后重新安装。</span>
        </div>
        <div class="publish-workbench__actions">
          <span v-if="centralUnavailable">中央服务恢复后可继续发布</span>
          <YButton v-if="resultUnconfirmed && canVerifyResult" :loading="verifyingResult" @click="emit('verify-result')">核实任务结果</YButton>
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
            <YButton v-if="!started" type="primary" :disabled="!canStartPublish" @click="handleStart">
              <template #icon><RocketOutlined /></template>
              开始发布
            </YButton>
            <YButton v-if="started && !running" type="primary" :disabled="!canStartPublish" @click="handleRepublish">
              <template #icon><SyncOutlined /></template>
              重新发布
            </YButton>
          </template>
        </div>
      </footer>
    </template>
  </a-drawer>
</template>

<style scoped lang="less">
@import './style.less';
</style>
