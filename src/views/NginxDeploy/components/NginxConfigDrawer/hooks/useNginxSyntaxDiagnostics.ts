import { ref, shallowRef, watch, type Ref } from 'vue';
import { parseNginxError, type ParsedNginxError } from '../utils/nginxErrorParser';

/** Monaco 校验 Marker 的统一 Owner 标识 */
const NGINX_MARKER_OWNER = 'nginx-syntax-validator';

/** MarkerSeverity.Error 常量值（Monaco 中 Error = 8） */
const MONACO_MARKER_SEVERITY_ERROR = 8;

/**
 * 动态安全获取 Monaco 全局或按需模块，避免静态依赖影响与初始化时机问题
 */
async function getMonacoApi() {
  if (typeof window !== 'undefined' && (window as any).monaco?.editor) {
    return (window as any).monaco;
  }
  try {
    return await import('monaco-editor/esm/vs/editor/editor.api');
  } catch {
    return null;
  }
}

/**
 * Nginx 语法与配置错误诊断与 Monaco 编辑器联动 Hook
 * @param content 当前编辑内容 Ref
 * @param diffMode 是否处于 Diff 对比模式
 * @param getDiffEditor 获取 DiffEditor 实例的方法
 */
export function useNginxSyntaxDiagnostics(
  content: Ref<string>,
  diffMode: Ref<boolean>,
  getDiffEditor?: () => any
) {
  /** 当前解析出的 Nginx 错误诊断对象 */
  const syntaxError = ref<ParsedNginxError | null>(null);

  /** 单栏普通 Monaco 实例引用 */
  const singleEditorInstance = shallowRef<any>(null);

  /**
   * 绑定单栏 Monaco 组件或原生实例
   */
  const bindSingleEditor = (instance: any) => {
    if (!instance) {
      singleEditorInstance.value = null;
      return;
    }
    const rawEditor = typeof instance.getInstance === 'function' ? instance.getInstance() : instance;
    singleEditorInstance.value = rawEditor;
  };

  /**
   * 获取当前处于激活编辑态的原生 Monaco CodeEditor 实例
   * （在 Diff 模式下为右侧可编辑的 ModifiedEditor）
   */
  const getActiveEditor = (): any => {
    if (diffMode.value) {
      const diffEditor = getDiffEditor?.();
      return diffEditor?.getModifiedEditor?.() || diffEditor || null;
    }
    return singleEditorInstance.value;
  };

  /**
   * 清除当前编辑器上的 Nginx 错误 Marker 波浪线
   */
  const clearEditorMarkers = async () => {
    try {
      const editor = getActiveEditor();
      const model = editor?.getModel?.();
      if (!model) return;

      const monacoApi = await getMonacoApi();
      if (monacoApi?.editor?.setModelMarkers) {
        monacoApi.editor.setModelMarkers(model, NGINX_MARKER_OWNER, []);
      }
    } catch {
      // 容错处理：编辑器未挂载时不抛错
    }
  };

  /**
   * 在当前编辑器中对指定错误行打上红波浪线与悬浮提示
   * @param error 诊断对象
   */
  const applyEditorMarkers = async (error: ParsedNginxError) => {
    if (!error.line) return;
    try {
      const editor = getActiveEditor();
      const model = editor?.getModel?.();
      if (!model) return;

      const line = error.line;
      const lineCount = model.getLineCount?.() || line;
      const safeLine = Math.min(Math.max(1, line), lineCount);
      const maxCol = model.getLineMaxColumn?.(safeLine) || 120;

      const monacoApi = await getMonacoApi();
      if (monacoApi?.editor?.setModelMarkers) {
        monacoApi.editor.setModelMarkers(model, NGINX_MARKER_OWNER, [
          {
            severity: monacoApi.MarkerSeverity?.Error || MONACO_MARKER_SEVERITY_ERROR,
            startLineNumber: safeLine,
            startColumn: 1,
            endLineNumber: safeLine,
            endColumn: maxCol,
            message: `${error.reason}\n建议：${error.suggestion}`,
            source: 'Nginx 校验',
          },
        ]);
      }
    } catch {
      // 容错处理
    }
  };

  /**
   * 平滑滚动并将光标聚焦到错误发生的行
   * @param line 目标行号
   */
  const jumpToLine = (line: number) => {
    try {
      const editor = getActiveEditor();
      if (!editor) return;

      const model = editor.getModel?.();
      const lineCount = model?.getLineCount?.() || line;
      const safeLine = Math.min(Math.max(1, line), lineCount);

      if (typeof editor.revealLineInCenter === 'function') {
        editor.revealLineInCenter(safeLine);
      }
      if (typeof editor.setPosition === 'function') {
        editor.setPosition({ lineNumber: safeLine, column: 1 });
      }
      if (typeof editor.focus === 'function') {
        editor.focus();
      }
    } catch {
      // 容错处理
    }
  };

  /**
   * 清除错误诊断信息与波浪线
   */
  const clearSyntaxError = () => {
    syntaxError.value = null;
    void clearEditorMarkers();
  };

  /**
   * 记录并解析 Nginx 报错，同时触发编辑器联动高亮与定位
   * @param error 错误对象或文本
   */
  const handleSyntaxError = (error: unknown): ParsedNginxError => {
    const parsed = parseNginxError(error);
    syntaxError.value = parsed;

    // 延迟一小段时间确保 DOM 与编辑器渲染稳定后再打 marker 并跳转
    setTimeout(() => {
      void applyEditorMarkers(parsed);
      if (parsed.line) {
        jumpToLine(parsed.line);
      }
    }, 60);

    return parsed;
  };

  // 用户修改代码时，自动清理旧的错误提示与波浪线
  watch(content, () => {
    if (syntaxError.value) {
      clearSyntaxError();
    }
  });

  return {
    syntaxError,
    bindSingleEditor,
    clearSyntaxError,
    handleSyntaxError,
    jumpToLine,
  };
}
