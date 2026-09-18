<script setup lang="ts">
import { computed } from 'vue';
import { YButton } from '@yss-ui/components/lite';
import type { RemoteExecResult } from '@/api/deploy';
import { PRESET_COMMAND_CHIPS } from '../../constant';

defineOptions({ name: 'RemoteFsExecPanel' });

interface RemoteFsExecPanelProps {
  commandText: string;
  executing: boolean;
  execResult: RemoteExecResult | null;
}

const props = defineProps<RemoteFsExecPanelProps>();
const emit = defineEmits<{
  (e: 'update:commandText', val: string): void;
  (e: 'run'): void;
}>();

const cmd = computed({
  get: () => props.commandText,
  set: (val: string) => emit('update:commandText', val),
});
</script>

<template>
  <div class="remote-exec-panel">
    <div class="exec-bar">
      <a-input
        v-model:value="cmd"
        size="small"
        placeholder="输入单次非交互式命令（如 ls -lh, df -h 等）"
        class="exec-input"
        @pressEnter="emit('run')"
      />
      <YButton type="primary" size="small" :loading="executing" @click="emit('run')">执行</YButton>
    </div>
    <div class="exec-presets">
      <span
        v-for="chip in PRESET_COMMAND_CHIPS"
        :key="chip.command"
        class="preset-chip"
        :title="chip.description"
        @click="emit('update:commandText', chip.command)"
      >
        {{ chip.label }} ({{ chip.command }})
      </span>
    </div>
    <div v-if="execResult" class="exec-output" :class="{ 'has-error': execResult.code !== 0 }">
      <div class="output-meta">$ {{ execResult.command }} (code: {{ execResult.code }}, {{ execResult.durationMs }}ms)</div>
      <div>{{ execResult.stdout || execResult.stderr || '(无输出)' }}</div>
    </div>
  </div>
</template>

<style scoped lang="less">
.remote-exec-panel {
  border-top: 1px solid #d9d9d9;
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;

  .exec-bar {
    display: flex;
    align-items: center;
    gap: 8px;

    .exec-input {
      background: #2b2b2b;
      color: #ffffff;
      border-color: #444444;
    }
  }

  .exec-presets {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;

    .preset-chip {
      font-size: 11px;
      background: #2d2d2d;
      border: 1px solid #434343;
      color: #b7eb8f;
      padding: 1px 8px;
      border-radius: 4px;
      cursor: pointer;

      &:hover {
        background: #383838;
        border-color: #52c41a;
      }
    }
  }

  .exec-output {
    max-height: 160px;
    overflow-y: auto;
    font-family: Menlo, Monaco, 'Courier New', monospace;
    font-size: 12px;
    line-height: 1.5;
    background: #141414;
    padding: 8px 12px;
    border-radius: 4px;
    border: 1px solid #303030;
    white-space: pre-wrap;
    word-break: break-all;

    .output-meta {
      color: #8c8c8c;
      margin-bottom: 4px;
    }

    &.has-error {
      color: #ff7875;
    }
  }
}
</style>
