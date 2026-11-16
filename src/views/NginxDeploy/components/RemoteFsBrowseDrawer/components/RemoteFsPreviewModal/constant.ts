/**
 * 远程文件预览弹窗相关类型与配置
 */

/** 远程文件预览弹窗属性 */
export interface RemoteFsPreviewModalProps {
  /** 弹窗显隐状态 */
  open: boolean;
  /** 加载中状态 */
  loading: boolean;
  /** 文件名 */
  fileName: string;
  /** 文件内容 */
  content: string;
  /** 打开后定位并选中的行号（可选，用于从 Nginx 报错跳到其他配置文件，#43 P1-1） */
  revealLine?: number | null;
  /** 标题后缀（可选，如「第 12 行，只读」） */
  titleSuffix?: string;
}

/** Monaco 编辑器静态只读配置 */
export const PREVIEW_MONACO_OPTIONS = {
  readOnly: true,
  minimap: { enabled: false },
  fontSize: 13,
  lineHeight: 20,
  wordWrap: 'on' as const,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderWhitespace: 'selection' as const,
};

/**
 * 根据文件名推导 Monaco 语法高亮语言
 * @param fileName 文件名（包含扩展名）
 * @returns Monaco 语言标识
 */
export function detectFileLanguage(fileName: string): string {
  const normalized = String(fileName || '').trim().toLowerCase();
  if (!normalized) return 'plaintext';

  // 针对特定配置文件名称的精确判断
  if (normalized === 'nginx.conf' || normalized.endsWith('.conf')) return 'nginx';
  if (normalized === 'dockerfile' || normalized.endsWith('.dockerfile')) return 'dockerfile';
  if (normalized.endsWith('.env') || normalized.includes('.env.')) return 'ini';

  const ext = normalized.split('.').pop() || '';
  const languageMap: Record<string, string> = {
    js: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    json: 'json',
    json5: 'json',
    html: 'html',
    htm: 'html',
    vue: 'html',
    css: 'css',
    less: 'less',
    scss: 'scss',
    sass: 'scss',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    yml: 'yaml',
    yaml: 'yaml',
    md: 'markdown',
    markdown: 'markdown',
    xml: 'xml',
    svg: 'xml',
    sql: 'sql',
    java: 'java',
    properties: 'ini',
    ini: 'ini',
    toml: 'ini',
  };

  return languageMap[ext] || 'plaintext';
}
