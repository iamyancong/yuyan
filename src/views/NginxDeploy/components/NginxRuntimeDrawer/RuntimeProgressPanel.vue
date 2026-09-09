<script setup lang="ts">
import { YMonaco } from '@yss-ui/components/lite';
import type { DeployProgressEvent } from '@/api/deploy';

defineOptions({ name: 'NginxRuntimeProgressPanel' });

/** Nginx 初始化进度状态 */
interface RuntimeProgressState {
  percent: number;
  title: string;
  detail: string;
  logs: DeployProgressEvent[];
  running: boolean;
}

/** Nginx 进度日志面板属性 */
interface RuntimeProgressPanelProps {
  progress: RuntimeProgressState;
  content: string;
  monacoOptions: Record<string, unknown>;
}

defineProps<RuntimeProgressPanelProps>();
</script>

<template>
  <section class="nginx-runtime-card nginx-runtime-progress-card">
    <div class="nginx-runtime-progress-header">
      <div class="nginx-runtime-progress-header__title">
        <strong>{{ progress.title || '等待执行' }}</strong>
        <span>{{ progress.detail || '初始化和运行时操作日志会保留在这里' }}</span>
      </div>
      <a-progress
        :percent="progress.percent"
        :status="progress.running ? 'active' : progress.percent >= 100 ? 'success' : 'normal'"
        class="nginx-runtime-progress"
      />
    </div>
    <div class="nginx-runtime-progress-monaco">
      <YMonaco
        :model-value="content"
        language="log"
        theme="vs-dark"
        height="360px"
        :readonly="true"
        log-mode
        :max-lines="20000"
        :auto-scroll="true"
        :show-border="false"
        :options="monacoOptions"
      />
    </div>
  </section>
</template>
