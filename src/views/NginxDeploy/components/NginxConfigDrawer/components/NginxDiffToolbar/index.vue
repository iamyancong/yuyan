<script setup lang="ts">
import { ref } from 'vue';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CheckCircleOutlined,
  CheckOutlined,
  CopyOutlined,
  DiffOutlined,
  UndoOutlined,
} from '@ant-design/icons-vue';
import message from 'ant-design-vue/es/message';
import { copyToClipboard } from '@yss-ui/utils';
import type { DiffSummary } from '../../constant';

defineOptions({ name: 'NginxDiffToolbar' });

/** 工具栏属性定义 */
interface Props {
  /** 是否存在未保存的修改 */
  isDirty: boolean;
  /** 是否开启 Diff 对比模式 */
  diffMode: boolean;
  /** 差异统计数据 */
  diffSummary: DiffSummary;
  /** 当前定位的差异序号 */
  currentChangeIndex: number;
  /** 差异总数 */
  totalChanges: number;
  /** 当前配置文本（供复制用） */
  content: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'toggleDiff', value: boolean): void;
  (e: 'nextDiff'): void;
  (e: 'prevDiff'): void;
  (e: 'revertDiff'): void;
}>();

/** 复制状态 */
const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

/** 复制当前配置内容 */
const handleCopyContent = async () => {
  if (!props.content) return;
  const success = await copyToClipboard(props.content);
  if (success) {
    message.success('当前配置已复制到剪贴板');
    copied.value = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied.value = false; }, 1600);
  }
};
</script>

<template>
  <div class="nginx-diff-toolbar" :class="{ 'is-diff-active': diffMode }">
    <!-- 左侧：模式指示与大文件上一处/下一处差异导航及块还原 -->
    <div class="toolbar-left">
      <template v-if="diffMode">
        <span class="diff-badge">
          <DiffOutlined class="badge-icon" />
          <span class="badge-text">diff · 基线</span>
        </span>

        <div v-if="totalChanges > 0" class="diff-nav-group">
          <button
            type="button"
            class="nav-btn"
            title="上一处变更"
            aria-label="上一处变更"
            @click="emit('prevDiff')"
          >
            <ArrowUpOutlined />
            <span>上一处</span>
          </button>

          <button
            type="button"
            class="nav-btn"
            title="下一处变更"
            aria-label="下一处变更"
            @click="emit('nextDiff')"
          >
            <ArrowDownOutlined />
            <span>下一处</span>
          </button>

          <button
            type="button"
            class="nav-btn nav-btn--revert"
            title="还原当前这处变更块（恢复为基线内容）"
            aria-label="还原当前变更块"
            @click="emit('revertDiff')"
          >
            <UndoOutlined />
            <span>还原此块</span>
          </button>

          <span class="nav-counter">{{ currentChangeIndex }}/{{ totalChanges }}</span>
        </div>
        <span v-else class="diff-clean-tag">
          <CheckCircleOutlined />
          <span>所有变更已还原</span>
        </span>
      </template>

      <template v-else>
        <span class="lang-tag">nginx · UTF-8</span>
      </template>
    </div>

    <!-- 右侧：dirty 对比开关与复制操作 -->
    <div class="toolbar-right">
      <!-- 在 dirty 或已在对比模式中时保持展示「对比变更」开关 -->
      <div v-if="isDirty || diffMode" class="diff-toggle-control" :class="{ 'is-active': diffMode }">
        <span class="toggle-text">对比变更</span>
        <a-switch
          :checked="diffMode"
          size="small"
          aria-label="切换对比变更"
          @update:checked="emit('toggleDiff', $event)"
        />
      </div>

      <!-- 快速复制配置 -->
      <a-tooltip :title="copied ? '已复制！' : '复制配置内容'" placement="top">
        <button
          type="button"
          class="action-icon-btn"
          :class="{ 'is-copied': copied }"
          aria-label="复制当前配置"
          @click="handleCopyContent"
        >
          <CheckOutlined v-if="copied" class="is-success" />
          <CopyOutlined v-else />
        </button>
      </a-tooltip>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
