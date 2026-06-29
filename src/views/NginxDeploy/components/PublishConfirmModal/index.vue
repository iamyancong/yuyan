<script setup lang="ts">
import { CheckCircleOutlined, ClockCircleOutlined, CloseCircleOutlined, RocketOutlined, StopOutlined, SyncOutlined } from '@ant-design/icons-vue';
import { YButton, YMonaco } from '@ycwang-dev/components/lite';
import { computed, ref, watch } from 'vue';
import type { PublishConfirmModalProps, PublishStartOptions } from './constant';
import { usePublishConfirm } from './hooks/usePublishConfirm';

defineOptions({ name: 'PublishConfirmModal' });

const props = defineProps<PublishConfirmModalProps>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'start', value: PublishStartOptions): void;
  (e: 'republish', value: PublishStartOptions): void;
  (e: 'stop'): void;
}>();

/** 是否强制重新安装依赖 */
const forceInstallDependencies = ref(false);

/** 业务逻辑 Hook */
const {
  logMonacoRef,
  finished,
  hasError,
  visibleStages,
  headerDescription,
  statusText,
  statusClassName,
  targetSummaries,
  publishLogContent,
  getStageStatus,
  getStageLabel,
} = usePublishConfirm(props);

/** 弹窗显隐状态 */
const visible = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
});

/** 开始发布 */
const handleStart = () => {
  emit('start', { forceInstallDependencies: forceInstallDependencies.value });
};

/** 重新发布 */
const handleRepublish = () => {
  emit('republish', { forceInstallDependencies: forceInstallDependencies.value });
};

watch(
  () => [props.open, props.target?.id],
  ([open]) => {
    if (open && !props.started) forceInstallDependencies.value = false;
  }
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

      <div class="publish-target-mini">
        <div v-for="item in targetSummaries" :key="item.label" class="publish-target-mini__item">
          <span>{{ item.label }}</span>
          <strong>{{ item.value }}</strong>
        </div>
      </div>

      <section class="publish-flow-panel">
        <div class="publish-flow-panel__head">
          <h4>{{ started ? '实时发布节点' : '发布节点预览' }}</h4>
          <a-tag :color="stopped ? 'default' : hasError ? 'error' : finished ? 'success' : started ? 'processing' : 'blue'">
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

      <section v-if="started" class="publish-log-panel">
        <div class="publish-log-panel__head">
          <h4>发布日志</h4>
          <a-space :size="8">
            <a-tag v-if="hasError" color="error">失败详情见日志</a-tag>
            <span>{{ logs.length }} 条</span>
          </a-space>
        </div>
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
          :options="{ minimap: { enabled: false }, fontSize: 13, wordWrap: 'on', readOnly: true }"
        />
      </section>
    </section>

    <template #footer>
      <footer class="publish-workbench__footer">
        <div v-if="!running" class="publish-cache-option">
          <a-checkbox v-model:checked="forceInstallDependencies">本次重新安装依赖</a-checkbox>
          <span>依赖缓存异常时使用，会清理旧 node_modules 后重新安装。</span>
        </div>
        <div class="publish-workbench__actions">
          <YButton @click="visible = false">{{ started && running ? '收起' : started ? '关闭' : '取消' }}</YButton>
          <YButton v-if="started && running" danger :disabled="!stoppable" :loading="stopping" @click="emit('stop')">
            <template #icon><StopOutlined /></template>
            {{ stoppable ? '停止' : '上传后不可停止' }}
          </YButton>
          <YButton v-if="!started" type="primary" :disabled="!target" @click="handleStart">
            <template #icon><RocketOutlined /></template>
            开始发布
          </YButton>
          <YButton v-if="started && !running" type="primary" :disabled="!target" @click="handleRepublish">
            <template #icon><SyncOutlined /></template>
            重新发布
          </YButton>
        </div>
      </footer>
    </template>
  </a-drawer>
</template>

<style scoped lang="less">
@import './style.less';
</style>
