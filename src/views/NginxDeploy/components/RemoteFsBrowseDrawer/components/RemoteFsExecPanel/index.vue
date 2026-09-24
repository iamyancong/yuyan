<script setup lang="ts">
import { computed } from 'vue';
import {
  CheckCircleOutlined,
  ClearOutlined,
  DownOutlined,
  ExclamationCircleOutlined,
  RightOutlined,
} from '@ant-design/icons-vue';
import { YButton } from '@yss-ui/components/lite';
import type { RemoteExecResult } from '@/api/deploy';
import { PRESET_COMMAND_CHIPS } from '../../constant';

defineOptions({ name: 'RemoteFsExecPanel' });

interface RemoteFsExecPanelProps {
  commandText: string;
  workingDirectory: string;
  executing: boolean;
  execResult: RemoteExecResult | null;
}

const props = defineProps<RemoteFsExecPanelProps>();
const emit = defineEmits<{
  (e: 'update:commandText', val: string): void;
  (e: 'run'): void;
  (e: 'close'): void;
}>();

const cmd = computed({
  get: () => props.commandText,
  set: (val: string) => emit('update:commandText', val),
});
</script>

<template>
  <section class="remote-exec-panel" aria-label="远程运维诊断终端">
    <!-- 终端顶部状态条 -->
    <div class="exec-panel-heading">
      <div class="terminal-title">
        <div class="terminal-traffic-lights" aria-hidden="true">
          <span class="light red" />
          <span class="light yellow" />
          <span class="light green" />
        </div>
        <strong>诊断终端</strong>
        <span class="terminal-pwd-badge" :title="`当前工作路径: ${workingDirectory}`">
          {{ workingDirectory || '/' }}
        </span>
      </div>
      <div class="terminal-ctrl-group">
        <button
          v-if="execResult"
          type="button"
          class="ctrl-icon-btn"
          title="清空输出"
          @click="emit('update:commandText', '')"
        >
          <ClearOutlined /> 清屏
        </button>
        <button type="button" class="ctrl-icon-btn" title="收起终端" @click="emit('close')">
          <DownOutlined />
        </button>
      </div>
    </div>

    <!-- 终端输入条 -->
    <div class="exec-bar">
      <span class="command-prompt" aria-hidden="true">$</span>
      <input
        v-model="cmd"
        placeholder="输入诊断命令，例如 ls -lh、df -h、du -sh *"
        class="exec-input-native"
        :disabled="executing"
        aria-label="远程命令"
        @keydown.enter="emit('run')"
      />
      <YButton type="primary" size="small" :loading="executing" @click="emit('run')">
        <template #icon><RightOutlined /></template>
        执行
      </YButton>
    </div>

    <!-- 常用预设命令芯片 -->
    <div class="exec-presets" aria-label="快捷预设命令">
      <span class="preset-label">快捷预设:</span>
      <button
        v-for="chip in PRESET_COMMAND_CHIPS"
        :key="chip.command"
        type="button"
        class="preset-chip"
        :title="chip.description"
        :disabled="executing"
        @click="emit('update:commandText', chip.command)"
      >
        <span>{{ chip.label }}</span>
        <code>{{ chip.command }}</code>
      </button>
    </div>

    <!-- 结果回显区 -->
    <div v-if="execResult" class="exec-output" :class="{ 'has-error': execResult.code !== 0 }">
      <div class="output-meta">
        <div class="result-command">
          <span class="prompt-symbol">$</span>
          <code>{{ execResult.command }}</code>
        </div>
        <div class="result-status">
          <ExclamationCircleOutlined v-if="execResult.code !== 0" />
          <CheckCircleOutlined v-else />
          <span class="status-code">退出码 {{ execResult.code }}</span>
          <span class="result-divider">·</span>
          <span class="status-duration">{{ execResult.durationMs }} ms</span>
        </div>
      </div>
      <pre class="output-pre">{{ execResult.stdout || execResult.stderr || '(无控制台输出)' }}</pre>
    </div>
  </section>
</template>

<style scoped lang="less">
@import './style.less';
</style>
