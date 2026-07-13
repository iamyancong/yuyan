<script setup lang="ts">
import { CheckOutlined, CloseOutlined, CopyOutlined, DownOutlined, LoadingOutlined, UpOutlined } from '@ant-design/icons-vue';
import { YButton } from '@ycwang-dev/components/lite';
import message from 'ant-design-vue/es/message';
import { computed, nextTick, ref, watch } from 'vue';
import {
  SERVICE_ACTION_META,
  SERVICE_PROGRESS_STAGES,
  formatServiceLogTime,
  getServiceLogLevel,
  getServiceLogMessage,
  type BackendServiceProgressModalProps,
} from './constant';

defineOptions({ name: 'BackendServiceProgressModal' });

const props = defineProps<BackendServiceProgressModalProps>();
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>();
const logExpanded = ref(true);
const logContainerRef = ref<HTMLElement | null>(null);
const hasError = computed(() => props.logs.some((item) => item.type === 'error'));
const finished = computed(() => !props.running && props.percent >= 100 && !hasError.value);
const meta = computed(() => SERVICE_ACTION_META[props.action]);
const statusText = computed(() => (hasError.value ? `${meta.value.verb}失败` : finished.value ? `${meta.value.verb}完成` : props.running ? `${meta.value.verb}中` : '等待执行'));
const modalClassName = computed(() => ({ 'is-running': props.running, 'is-success': finished.value, 'is-error': hasError.value }));
const activeStageThreshold = computed(() => [...SERVICE_PROGRESS_STAGES].reverse().find((stage) => props.percent >= stage.threshold)?.threshold ?? 0);

/** 关闭进度弹窗，运行中的任务仍在后台继续 */
const closeModal = () => emit('update:open', false);

/** 复制当前服务操作日志 */
const copyLogs = async () => {
  const content = props.logs.map((item) => `${formatServiceLogTime(item.timestamp)} [${getServiceLogLevel(item)}] ${getServiceLogMessage(item)}`).join('\n');
  try {
    await navigator.clipboard.writeText(content);
    message.success('运行日志已复制');
  } catch {
    message.error('复制失败，请检查剪贴板权限');
  }
};

/** 获取阶段状态 */
const getStageState = (threshold: number) => {
  if (hasError.value) {
    if (threshold < activeStageThreshold.value) return 'done';
    return threshold === activeStageThreshold.value ? 'error' : 'waiting';
  }
  if (props.percent > threshold || (threshold === 100 && finished.value)) return 'done';
  if (props.percent >= threshold && props.running) return 'active';
  return 'waiting';
};

watch(() => props.logs.length, async () => {
  await nextTick();
  if (logContainerRef.value) logContainerRef.value.scrollTop = logContainerRef.value.scrollHeight;
});
</script>

<template>
  <a-modal :open="open" width="min(840px, calc(100vw - 32px))" :footer="null" :title="null" :closable="false" :mask-closable="!running" centered wrap-class-name="service-progress-modal-root" @cancel="closeModal">
    <section class="service-progress" :class="modalClassName">
      <button class="service-progress__close" type="button" :aria-label="running ? '转至后台运行' : '关闭'" @click="closeModal"><CloseOutlined /></button>
      <div class="service-progress__aurora service-progress__aurora--top" />
      <div class="service-progress__aurora service-progress__aurora--side" />
      <header class="service-progress__header">
        <div class="service-progress__eyebrow"><span class="service-progress__live-dot" />{{ meta.label }}</div>
        <h2>{{ title || `准备${meta.verb}服务` }}</h2>
        <p>{{ detail || meta.hint }}</p>
      </header>

      <div class="service-progress__dashboard">
        <div class="service-progress__orb" :style="{ '--service-progress': `${Math.max(2, percent * 3.6)}deg` }">
          <div class="service-progress__orb-core">
            <LoadingOutlined v-if="running" class="service-progress__orb-icon" />
            <CheckOutlined v-else-if="finished" class="service-progress__orb-icon" />
            <CloseOutlined v-else-if="hasError" class="service-progress__orb-icon" />
            <strong>{{ percent }}<small>%</small></strong><span>{{ statusText }}</span>
          </div>
        </div>
        <div class="service-progress__summary">
          <div><span>服务</span><strong>{{ target?.serviceName || target?.projectName || '当前服务' }}</strong></div>
          <div><span>运行节点</span><strong>{{ target?.serverName || target?.serverHost || '目标服务器' }}</strong></div>
          <div><span>运行模式</span><strong>{{ target?.processMode || '托管进程' }}</strong></div>
        </div>
      </div>

      <ol class="service-progress__stages" aria-label="服务操作阶段">
        <li v-for="(stage, index) in SERVICE_PROGRESS_STAGES" :key="stage.key" :class="`is-${getStageState(stage.threshold)}`">
          <span class="service-progress__stage-node"><CheckOutlined v-if="getStageState(stage.threshold) === 'done'" /><LoadingOutlined v-else-if="getStageState(stage.threshold) === 'active'" /> <i v-else /></span>
          <strong>{{ stage.label }}</strong><small>0{{ index + 1 }}</small>
        </li>
      </ol>

      <section class="service-progress__logs" :class="{ 'is-collapsed': !logExpanded }">
        <button class="service-progress__logs-head" type="button" @click="logExpanded = !logExpanded">
          <span><i />实时运行日志 <small>{{ logs.length }} 条</small></span><UpOutlined v-if="logExpanded" /><DownOutlined v-else />
        </button>
        <div v-if="logExpanded" ref="logContainerRef" class="service-progress__log-content">
          <div v-if="!logs.length" class="service-progress__log-empty"><LoadingOutlined v-if="running" /> 等待服务返回运行日志…</div>
          <div v-for="(item, index) in logs" :key="`${item.timestamp}-${index}`" :class="['service-progress__log-line', `is-${item.type}`]">
            <time>{{ formatServiceLogTime(item.timestamp) }}</time><b>{{ getServiceLogLevel(item) }}</b><span>{{ getServiceLogMessage(item) }}</span>
          </div>
        </div>
      </section>

      <footer class="service-progress__footer">
        <span>{{ running ? '关闭弹窗不会中断任务，可从项目运行态再次查看' : finished ? '运行状态已同步，可以安全关闭' : hasError ? '请根据运行日志检查环境或服务配置' : '操作已结束' }}</span>
        <div><YButton :disabled="!logs.length" @click="copyLogs"><template #icon><CopyOutlined /></template>复制日志</YButton><YButton type="primary" @click="closeModal">{{ running ? '转至后台' : '完成' }}</YButton></div>
      </footer>
    </section>
  </a-modal>
</template>

<style scoped lang="less">
@import './style.less';
</style>
