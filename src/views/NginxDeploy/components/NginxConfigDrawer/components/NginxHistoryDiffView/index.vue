<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CheckCircleOutlined,
  CloseOutlined,
  HistoryOutlined,
  ReloadOutlined,
  RollbackOutlined,
} from '@ant-design/icons-vue';
import { YMonacoDiff } from 'virtual:yss-heavy-components';
import type { NginxConfHistoryItem } from '@/api/deploy';
import { HISTORY_DIFF_MONACO_OPTIONS } from '../../constant';
import { useNginxDiff } from '../../hooks/useNginxDiff';
import { formatBeijingShort, formatBeijingTime, resolveHistoryItemTime } from '../../historyPolicy';

defineOptions({ name: 'NginxHistoryDiffView' });

/** 历史版本只读对比视图属性 */
interface Props {
  /** 正在对比的历史条目 */
  item: NginxConfHistoryItem;
  /** 历史版本内容 */
  historyContent: string;
  /** 刚读取的线上当前内容 */
  currentContent: string;
  /** 线上内容读取时间（ISO） */
  currentFetchedAt: string;
  /** 加载中 */
  loading: boolean;
  /** 只读角色：不能恢复 */
  readonly?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: 'restore'): void;
  (e: 'exit'): void;
  (e: 'refresh-current'): void;
}>();

const historyRef = toRef(props, 'historyContent');
const currentRef = toRef(props, 'currentContent');
const alwaysDirty = ref(true);

// 复用 useNginxDiff 的导航与统计能力：左 = 历史版本，右 = 线上当前
const { diffMode, diffSummary, currentChangeIndex, totalChanges, bindDiffEditor, handleNextDiff, handlePrevDiff, resetDiffState } =
  useNginxDiff(currentRef, historyRef, alwaysDirty, alwaysDirty);
diffMode.value = true;

/** 历史与线上完全一致 */
const identical = computed(() => !props.loading && props.historyContent === props.currentContent);

/** 左侧标题 */
const leftTitle = computed(() => {
  const time = formatBeijingShort(resolveHistoryItemTime(props.item));
  if (props.item.source === 'external') return `历史版本 · ${props.item.name}（外部备份${time ? `，修改于 ${time}` : ''}）`;
  return `历史版本 · ${time}（被替换前）`;
});

/** 右侧标题 */
const rightTitle = computed(() => {
  const fetched = formatBeijingTime(props.currentFetchedAt);
  return fetched ? `线上当前 · 刚刚读取（${fetched.slice(11)}）` : '线上当前 · 刚刚读取';
});

/** 恢复按钮禁用原因 */
const restoreDisabledReason = computed(() => {
  if (props.readonly) return '当前账号为只读角色，不能恢复配置';
  if (identical.value) return '与当前线上一致，无需恢复';
  return '';
});

watch(
  () => props.item?.name,
  () => resetDiffState()
);
</script>

<template>
  <div class="nginx-history-diff-view">
    <div class="history-diff-toolbar">
      <div class="toolbar-left">
        <span class="history-badge">
          <HistoryOutlined />
          <span>历史 ↔ 线上</span>
        </span>
        <template v-if="!loading">
          <span v-if="identical" class="identical-tag">
            <CheckCircleOutlined />
            <span>与当前线上一致</span>
          </span>
          <div v-else-if="totalChanges > 0" class="diff-nav-group">
            <button type="button" class="nav-btn" title="上一处差异" @click="handlePrevDiff">
              <ArrowUpOutlined />
              <span>上一处</span>
            </button>
            <button type="button" class="nav-btn" title="下一处差异" @click="handleNextDiff">
              <ArrowDownOutlined />
              <span>下一处</span>
            </button>
            <span class="nav-counter">{{ currentChangeIndex }}/{{ totalChanges }}</span>
            <span class="nav-summary">+{{ diffSummary.addedLines }} / -{{ diffSummary.removedLines }} 行</span>
          </div>
        </template>
      </div>
      <div class="toolbar-right">
        <a-tooltip title="重新读取线上当前配置" placement="top">
          <button type="button" class="icon-btn" :disabled="loading" aria-label="重新读取线上配置" @click="emit('refresh-current')">
            <ReloadOutlined />
          </button>
        </a-tooltip>
        <a-tooltip :title="restoreDisabledReason || '把该历史版本载入编辑器，确认后再点「保存并重载」生效'" placement="top">
          <a-button
            size="small"
            type="primary"
            :disabled="loading || Boolean(restoreDisabledReason)"
            class="restore-btn"
            @click="emit('restore')"
          >
            <template #icon><RollbackOutlined /></template>
            恢复到编辑器
          </a-button>
        </a-tooltip>
        <a-button size="small" class="exit-btn" @click="emit('exit')">
          <template #icon><CloseOutlined /></template>
          退出对比
        </a-button>
      </div>
    </div>
    <div class="history-diff-header">
      <span class="side-title side-title--history">◀ {{ leftTitle }}</span>
      <span class="side-title side-title--current">{{ rightTitle }} ▶</span>
    </div>
    <div class="history-diff-content">
      <a-spin :spinning="loading" class="history-diff-spin">
        <YMonacoDiff
          v-if="!loading"
          :ref="bindDiffEditor"
          :original="historyContent"
          :value="currentContent"
          language="nginx"
          theme="vs-dark"
          height="100%"
          :auto-layout="true"
          :format-on-mount="false"
          :toolbar-tooltip="false"
          :toolbar-options="{ copy: false, fullscreen: true }"
          :options="HISTORY_DIFF_MONACO_OPTIONS"
        />
      </a-spin>
    </div>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>
