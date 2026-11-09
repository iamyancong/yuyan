<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

defineOptions({ name: 'MiddleEllipsisText' });

/** 省略标记 */
const ELLIPSIS = '...';

/** 默认字符宽度，用于首次测量前兜底 */
const DEFAULT_CHAR_WIDTH = 7.2;

/** 需要给单元格右侧预留的像素余量 */
const CELL_SAFE_GAP = 8;

/** 保留完整尾段时，左侧最少展示字符数 */
const MIN_PREFIX_LENGTH = 8;

const props = withDefaults(
  defineProps<{
    text?: string;
    startLength?: number;
    endLength?: number;
    separator?: string;
    tailSegments?: number;
    placeholder?: string;
  }>(),
  {
    text: '',
    startLength: 18,
    endLength: 32,
    separator: '/',
    tailSegments: 1,
    placeholder: '-',
  }
);

const textRef = ref<HTMLElement | null>(null);
const containerWidth = ref(0);
const charWidth = ref(DEFAULT_CHAR_WIDTH);
let resizeObserver: ResizeObserver | null = null;

/** 当前单元格的字体只测量一次，避免观察回调里反复插入节点并强制布局。 */
const charWidthCache = new Map<string, number>();
const pendingMeasures = new Set<() => void>();
let measureFrame = 0;

/**
 * 把测量安排到下一帧，并合并同一帧里的全部单元格。
 * @param run 实际测量
 */
const scheduleMeasure = (run: () => void) => {
  pendingMeasures.add(run);
  if (measureFrame) return;
  measureFrame = requestAnimationFrame(() => {
    measureFrame = 0;
    const batch = Array.from(pendingMeasures);
    pendingMeasures.clear();
    batch.forEach((fn) => fn());
  });
};

/**
 * 获取可展示的原始文本。
 * @returns 原始文本或占位符
 */
const rawText = computed(() => props.text?.trim() || props.placeholder);

/**
 * 获取尾段文本。
 * @param value - 完整文本
 * @returns 最后一个路径片段
 */
const getTailSegment = (value: string) => {
  if (!props.separator || value === props.placeholder || !value.includes(props.separator)) return '';
  const segments = value.split(props.separator).filter(Boolean);
  const tailCount = Math.max(1, props.tailSegments);
  if (segments.length <= tailCount) return '';
  return segments.slice(-tailCount).join(props.separator);
};

/**
 * 获取可展示字符数。
 * @returns 当前容器宽度下可容纳的近似字符数
 */
const visibleCharCount = computed(() => {
  const width = containerWidth.value || (props.startLength + props.endLength + ELLIPSIS.length) * charWidth.value;
  return Math.max(0, Math.floor((width - CELL_SAFE_GAP) / charWidth.value));
});

/**
 * 构建中间省略文本。
 * @param value - 完整文本
 * @param visibleCount - 可展示字符数
 * @returns 中间省略后的文本
 */
const buildMiddleText = (value: string, visibleCount: number) => {
  if (value.length <= visibleCount || visibleCount <= ELLIPSIS.length + 2) return value;

  const usableCount = Math.max(2, visibleCount - ELLIPSIS.length);
  const tail = getTailSegment(value);
  if (tail && tail.length + MIN_PREFIX_LENGTH <= usableCount) {
    const prefixCount = Math.max(MIN_PREFIX_LENGTH, usableCount - tail.length);
    return `${value.slice(0, prefixCount)}${ELLIPSIS}${tail}`;
  }

  const startCount = Math.max(1, Math.floor(usableCount / 2));
  const endCount = Math.max(1, usableCount - startCount);
  return `${value.slice(0, startCount)}${ELLIPSIS}${value.slice(-endCount)}`;
};

/**
 * 获取最终展示文本。
 * @returns 当前宽度下的省略文本
 */
const displayText = computed(() => buildMiddleText(rawText.value, visibleCharCount.value));

/**
 * 判断当前文本是否已被截断省略。
 * @returns 是否处于省略状态
 */
const isEllipsized = computed(() => displayText.value !== rawText.value);

/**
 * 测量当前字体的平均字符宽度。
 * @param element - 文本容器
 * @returns 平均字符宽度
 */
const measureCharWidth = (element: HTMLElement) => {
  const style = window.getComputedStyle(element);
  const cacheKey = `${style.fontFamily}|${style.fontSize}|${style.fontWeight}`;
  const cached = charWidthCache.get(cacheKey);
  if (cached) return cached;
  const sample = document.createElement('span');
  sample.textContent = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  sample.style.position = 'absolute';
  sample.style.visibility = 'hidden';
  sample.style.whiteSpace = 'nowrap';
  sample.style.fontFamily = style.fontFamily;
  sample.style.fontSize = style.fontSize;
  sample.style.fontWeight = style.fontWeight;
  document.body.appendChild(sample);
  const width = sample.getBoundingClientRect().width / (sample.textContent?.length || 1) || DEFAULT_CHAR_WIDTH;
  document.body.removeChild(sample);
  charWidthCache.set(cacheKey, width);
  return width;
};

/**
 * 按已知宽度更新省略结果。宽度没变时不写响应式数据，避免观察器来回触发。
 * @param width 容器宽度
 */
const applyWidth = (width: number) => {
  const element = textRef.value;
  if (!element || width <= 0) return;
  const nextCharWidth = measureCharWidth(element);
  if (Math.abs(width - containerWidth.value) < 1 && Math.abs(nextCharWidth - charWidth.value) < 0.01) return;
  containerWidth.value = width;
  charWidth.value = nextCharWidth;
};

/**
 * 更新容器宽度和字符宽度。
 */
const updateMeasurements = () => {
  if (!textRef.value) return;
  applyWidth(textRef.value.getBoundingClientRect().width);
};

/** 当前实例排队中的测量，卸载时从队列移除。 */
let queuedMeasure: (() => void) | null = null;

onMounted(async () => {
  await nextTick();
  updateMeasurements();
  if (!textRef.value) return;
  resizeObserver = new ResizeObserver((entries) => {
    const width = entries[0]?.contentRect.width ?? 0;
    if (width <= 0) return;
    if (queuedMeasure) pendingMeasures.delete(queuedMeasure);
    queuedMeasure = () => applyWidth(width);
    scheduleMeasure(queuedMeasure);
  });
  resizeObserver.observe(textRef.value);
});

onBeforeUnmount(() => {
  if (queuedMeasure) pendingMeasures.delete(queuedMeasure);
  resizeObserver?.disconnect();
  resizeObserver = null;
});

watch(rawText, async () => {
  await nextTick();
  updateMeasurements();
});
</script>

<template>
  <a-tooltip :title="isEllipsized ? rawText : undefined">
    <span ref="textRef" class="middle-ellipsis-text">{{ displayText }}</span>
  </a-tooltip>
</template>

<style scoped lang="less">
.middle-ellipsis-text {
  display: inline-block;
  width: 100%;
  max-width: 100%;
  overflow: hidden;
  color: var(--text-color);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
  font-size: 12px;
  white-space: nowrap;
}
</style>
