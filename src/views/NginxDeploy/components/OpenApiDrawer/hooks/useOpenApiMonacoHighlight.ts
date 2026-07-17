import { ref, watch, type Ref } from 'vue';

/** Monaco 文本模型最小接口。 */
interface MonacoTextModel {
  getLineCount: () => number;
  forceTokenization?: (lineNumber: number) => void;
}

/** YMonaco 暴露实例的最小接口。 */
interface YMonacoExpose {
  getInstance: () => { getModel?: () => MonacoTextModel | null } | null;
}

/**
 * 确保大体积 OpenAPI JSON 打开后首屏立即完成语法着色。
 * @param content OpenAPI 文本
 * @returns YMonaco 组件引用
 */
export const useOpenApiMonacoHighlight = (content: () => string): { monacoRef: Ref<YMonacoExpose | null> } => {
  const monacoRef = ref<YMonacoExpose | null>(null);
  let renderGeneration = 0;

  /** 等待异步编辑器就绪并预先着色首屏附近内容。 */
  const forceInitialTokenization = async () => {
    const generation = ++renderGeneration;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
      if (generation !== renderGeneration) return;
      const model = monacoRef.value?.getInstance()?.getModel?.();
      if (!model) continue;
      model.forceTokenization?.(Math.min(model.getLineCount(), 1000));
      return;
    }
  };

  watch(content, (value) => {
    if (value) void forceInitialTokenization();
  }, { immediate: true, flush: 'post' });

  return { monacoRef };
};
