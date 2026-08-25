/** 仓库文件读取函数；文件不存在时返回 null。 */
export type RepositoryFileReader = (filePath: string) => Promise<string | null>;

/** 前端部署应用识别结果。 */
export interface DeployApplicationDetection {
  status: 'resolved' | 'unresolved';
  kind?: 'main' | 'micro';
  appName?: string;
  mode: string;
  sourcePath?: string;
  reason: string;
}

/** 前端部署应用识别参数。 */
export interface DetectDeployApplicationOptions {
  buildCommand: string;
  artifactDir?: string;
  projectName?: string;
  projectDescription?: string;
  readFile: RepositoryFileReader;
}

/** 构建脚本解析结果。 */
interface BuildContext {
  workingDir: string;
  mode: string;
  framework: 'vite' | 'vue-cli' | 'unknown';
  safe: boolean;
}

/** 安全的微应用目录名单段格式。 */
const APP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 构建脚本最多解析层数。 */
const MAX_SCRIPT_DEPTH = 3;

/**
 * 规范化仓库内相对路径。
 * @param value 原始相对路径
 * @returns 安全的 POSIX 相对路径
 */
function normalizeRepositoryPath(value?: string): string {
  const original = String(value || '').trim().replace(/\\/g, '/');
  if (!original || original === '.') return '';
  if (original.startsWith('/')) return '';
  const segments: string[] = [];
  for (const segment of original.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) return '';
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/**
 * 拼接仓库相对路径。
 * @param baseDir 基础目录
 * @param childPath 子路径
 * @returns 安全的仓库路径
 */
function joinRepositoryPath(baseDir: string, childPath: string): string {
  return normalizeRepositoryPath([baseDir, childPath].filter(Boolean).join('/'));
}

/**
 * 去除简单 Shell 参数引号。
 * @param value Shell 参数
 * @returns 去引号后的值
 */
function stripShellQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * 从命令中解析 Vite mode。
 * @param command 构建命令
 * @returns Vite mode
 */
export function parseViteMode(command: string): string {
  const match = String(command || '').match(/(?:^|\s)--mode(?:=|\s+)([^\s;&|]+)/);
  return stripShellQuotes(match?.[1] || '') || 'production';
}

/**
 * 解析 package manager 脚本调用。
 * @param commandSegment 单段命令
 * @returns 脚本名称
 */
function parsePackageScriptName(commandSegment: string): string {
  const segment = commandSegment.trim();
  const match = segment.match(/^(?:pnpm|yarn)(?:\s+run)?\s+([^\s;&|]+)|^npm\s+run\s+([^\s;&|]+)/);
  return stripShellQuotes(match?.[1] || match?.[2] || '');
}

/**
 * 安全解析构建命令的工作目录、框架与 mode。
 * @param buildCommand 表单构建命令
 * @param readFile 仓库文件读取函数
 * @returns 构建上下文
 */
export async function resolveBuildContext(buildCommand: string, readFile: RepositoryFileReader): Promise<BuildContext> {
  let workingDir = '';
  let command = String(buildCommand || '').trim();
  let modeHint = /(?:^|[:\s])standalone(?:$|\s)/i.test(command) ? 'production.standalone' : '';
  const visitedScripts = new Set<string>();

  for (let depth = 0; depth <= MAX_SCRIPT_DEPTH && command; depth += 1) {
    const containsSingleAmpersand = command.replace(/&&/g, '').includes('&');
    if (/[;|<>`\n\r$()]/.test(command) || containsSingleAmpersand) {
      return { workingDir, mode: modeHint || 'production', framework: 'unknown', safe: false };
    }
    const segments = command.split(/\s*&&\s*/).map((item) => item.trim()).filter(Boolean);
    let nestedCommand = '';

    for (const segment of segments) {
      const cdMatch = segment.match(/^cd\s+(.+)$/);
      if (cdMatch) {
        const nextDir = normalizeRepositoryPath([workingDir, stripShellQuotes(cdMatch[1])].filter(Boolean).join('/'));
        if (!nextDir && stripShellQuotes(cdMatch[1]) !== '.') {
          return { workingDir, mode: modeHint || 'production', framework: 'unknown', safe: false };
        }
        workingDir = nextDir;
        continue;
      }

      if (/\bvite\s+build\b/.test(segment)) {
        return { workingDir, mode: modeHint || parseViteMode(segment), framework: 'vite', safe: true };
      }
      if (/\bvue-cli-service\s+build\b/.test(segment)) {
        return { workingDir, mode: 'production', framework: 'vue-cli', safe: true };
      }
      if (/\blerna\s+run\b.*(?:^|\s)build(?:$|\s)/.test(segment)) {
        const viewPackagePath = joinRepositoryPath(workingDir, 'packages/view/package.json') || 'packages/view/package.json';
        const viewPackageContent = await readFile(viewPackagePath);
        if (viewPackageContent) {
          try {
            const viewPackage = JSON.parse(viewPackageContent) as { scripts?: Record<string, string> };
            const viewBuildCommand = String(viewPackage.scripts?.build || '');
            const viewWorkingDir = joinRepositoryPath(workingDir, 'packages/view');
            if (/\bvue-cli-service\s+build\b/.test(viewBuildCommand)) {
              return { workingDir: viewWorkingDir, mode: 'production', framework: 'vue-cli', safe: true };
            }
            if (/\bvite\s+build\b/.test(viewBuildCommand)) {
              return { workingDir: viewWorkingDir, mode: parseViteMode(viewBuildCommand), framework: 'vite', safe: true };
            }
          } catch {
            return { workingDir, mode: 'production', framework: 'unknown', safe: false };
          }
        }
        return { workingDir, mode: 'production', framework: 'unknown', safe: true };
      }

      const scriptName = parsePackageScriptName(segment);
      if (!scriptName) continue;
      if (/standalone/i.test(scriptName)) modeHint = 'production.standalone';
      const scriptKey = `${workingDir}:${scriptName}`;
      if (visitedScripts.has(scriptKey)) {
        return { workingDir, mode: modeHint || 'production', framework: 'unknown', safe: false };
      }
      visitedScripts.add(scriptKey);
      const packagePath = joinRepositoryPath(workingDir, 'package.json') || 'package.json';
      const packageContent = await readFile(packagePath);
      if (!packageContent) {
        return { workingDir, mode: modeHint || 'production', framework: 'unknown', safe: false };
      }
      try {
        const packageJson = JSON.parse(packageContent) as { scripts?: Record<string, string> };
        nestedCommand = String(packageJson.scripts?.[scriptName] || '').trim();
      } catch {
        return { workingDir, mode: modeHint || 'production', framework: 'unknown', safe: false };
      }
      if (nestedCommand) break;
    }

    if (!nestedCommand) break;
    command = nestedCommand;
  }

  return { workingDir, mode: modeHint || parseViteMode(command), framework: 'unknown', safe: false };
}

/**
 * 从 dotenv 文本读取 VITE_SUB_APP_NAME。
 * @param content dotenv 文件内容
 * @returns 微应用名称
 */
export function parseViteSubAppName(content: string): string {
  let result = '';
  String(content || '').split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*(?:export\s+)?VITE_SUB_APP_NAME\s*=\s*(.*?)\s*$/);
    if (!match) return;
    let value = match[1].replace(/\s+#.*$/, '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result = value;
  });
  return result;
}

/**
 * 区分 dotenv 变量未声明与显式声明为空。
 * @param content dotenv 文件内容
 * @returns 是否声明及最终变量值
 */
function readViteSubAppNameAssignment(content: string): { found: boolean; value: string } {
  let found = false;
  let value = '';
  String(content || '').split(/\r?\n/).forEach((line) => {
    if (!/^\s*(?:export\s+)?VITE_SUB_APP_NAME\s*=/.test(line)) return;
    found = true;
    value = parseViteSubAppName(line);
  });
  return { found, value };
}

/**
 * 从 HTML 中解析 yss-main-app 根节点 ID。
 * @param content HTML 内容
 * @returns 去重后的应用 ID
 */
export function parseVue2AppIds(content: string): string[] {
  const ids = new Set<string>();
  const html = String(content || '').replace(/<!--[\s\S]*?-->/g, '');
  const tagPattern = /<[A-Za-z][\w:-]*\b([^>]*)>/g;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagPattern.exec(html))) {
    const attributes: Record<string, string> = {};
    const attributePattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let attributeMatch: RegExpExecArray | null;
    while ((attributeMatch = attributePattern.exec(tagMatch[1]))) {
      attributes[attributeMatch[1].toLowerCase()] = attributeMatch[2] ?? attributeMatch[3] ?? '';
    }
    const classNames = String(attributes.class || '').split(/\s+/).filter(Boolean);
    const id = String(attributes.id || '').trim();
    if (id && classNames.includes('yss-main-app')) ids.add(id);
  }
  return Array.from(ids);
}

/**
 * 判断项目快照是否明确标注主应用。
 * @param projectName 项目名称
 * @param projectDescription 项目描述
 * @returns 是否明确为主应用
 */
export function isExplicitMainApplication(projectName?: string, projectDescription?: string): boolean {
  return /主应用/.test(`${projectName || ''} ${projectDescription || ''}`);
}

/**
 * 获取仓库配置候选工作目录。
 * @param context 构建上下文
 * @param artifactDir 产物目录
 * @returns 去重后的工作目录
 */
function getCandidateDirectories(context: BuildContext, artifactDir?: string): string[] {
  if (context.framework !== 'unknown') return [normalizeRepositoryPath(context.workingDir)];
  const artifactPath = normalizeRepositoryPath(artifactDir);
  const artifactSegments = artifactPath.split('/').filter(Boolean);
  const artifactParent = artifactPath && !/[?*{}]/.test(artifactPath)
    ? normalizeRepositoryPath(artifactSegments.slice(0, -1).join('/'))
    : '';
  return Array.from(new Set([context.workingDir, artifactParent, 'packages/view', 'packages', ''].map(normalizeRepositoryPath)));
}

/**
 * 读取指定 Vite mode 合并后的微应用名称。
 * @param directory Vite 工作目录
 * @param mode Vite mode
 * @param readFile 仓库读取函数
 * @returns 标识及来源文件
 */
async function readViteAppName(directory: string, mode: string, readFile: RepositoryFileReader): Promise<{ appName: string; sourcePath: string } | null> {
  const fileNames = ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`];
  let result: { appName: string; sourcePath: string } | null = null;
  for (const fileName of fileNames) {
    const filePath = joinRepositoryPath(directory, fileName) || fileName;
    const content = await readFile(filePath);
    if (!content) continue;
    const assignment = readViteSubAppNameAssignment(content);
    if (!assignment.found) continue;
    result = assignment.value ? { appName: assignment.value, sourcePath: filePath } : null;
  }
  return result;
}

/**
 * 按当前分支仓库配置识别主应用或微应用。
 * @param options 识别参数
 * @returns 应用识别结果
 */
export async function detectDeployApplication(options: DetectDeployApplicationOptions): Promise<DeployApplicationDetection> {
  const context = await resolveBuildContext(options.buildCommand, options.readFile);
  if (!context.safe) {
    return { status: 'unresolved', mode: context.mode, reason: '构建命令包含无法安全解析的 Shell 语法' };
  }
  if (isExplicitMainApplication(options.projectName, options.projectDescription)) {
    return { status: 'resolved', kind: 'main', mode: context.mode, reason: '项目名称或描述已标注为主应用' };
  }
  if (/standalone/i.test(context.mode)) {
    return { status: 'resolved', kind: 'main', mode: context.mode, reason: `构建 mode ${context.mode} 为 standalone 主应用` };
  }

  const directories = getCandidateDirectories(context, options.artifactDir);
  const viteMatches: Array<{ appName: string; sourcePath: string }> = [];
  if (context.framework !== 'vue-cli') {
    for (const directory of directories) {
      const match = await readViteAppName(directory, context.mode || 'production', options.readFile);
      if (match) viteMatches.push(match);
    }
  }
  const viteNames = Array.from(new Set(viteMatches.map((item) => item.appName)));
  if (viteNames.length > 1) {
    return { status: 'unresolved', mode: context.mode, reason: `当前构建 mode 检测到多个 VITE_SUB_APP_NAME：${viteNames.join('、')}` };
  }
  if (viteNames.length === 1) {
    const match = viteMatches.find((item) => item.appName === viteNames[0]);
    if (!APP_NAME_PATTERN.test(viteNames[0])) {
      return { status: 'unresolved', mode: context.mode, reason: 'VITE_SUB_APP_NAME 不是安全的单级目录名' };
    }
    return {
      status: 'resolved',
      kind: 'micro',
      appName: viteNames[0],
      mode: context.mode,
      sourcePath: match?.sourcePath,
      reason: `从 ${match?.sourcePath || 'Vite 环境文件'} 识别微应用目录`,
    };
  }

  const vue2Matches: Array<{ appName: string; sourcePath: string }> = [];
  if (context.framework !== 'vite') {
    for (const directory of directories) {
      const filePath = joinRepositoryPath(directory, 'public/index.html') || 'public/index.html';
      const content = await options.readFile(filePath);
      if (!content) continue;
      parseVue2AppIds(content).forEach((appName) => vue2Matches.push({ appName, sourcePath: filePath }));
    }
  }
  const vue2Names = Array.from(new Set(vue2Matches.map((item) => item.appName)));
  if (vue2Names.length > 1) {
    return { status: 'unresolved', mode: context.mode, reason: `检测到多个 Vue2 yss-main-app ID：${vue2Names.join('、')}` };
  }
  if (vue2Names.length === 1) {
    const appName = vue2Names[0];
    const match = vue2Matches.find((item) => item.appName === appName);
    if (appName.toLowerCase() === 'yssmainapp') {
      return { status: 'resolved', kind: 'main', mode: context.mode, sourcePath: match?.sourcePath, reason: 'Vue2 yssMainApp 门户主应用' };
    }
    if (!APP_NAME_PATTERN.test(appName)) {
      return { status: 'unresolved', mode: context.mode, reason: 'Vue2 应用 ID 不是安全的单级目录名' };
    }
    return {
      status: 'resolved',
      kind: 'micro',
      appName,
      mode: context.mode,
      sourcePath: match?.sourcePath,
      reason: `从 ${match?.sourcePath || 'public/index.html'} 识别微应用目录`,
    };
  }

  return {
    status: 'unresolved',
    mode: context.mode,
    reason: `未在当前分支的 ${context.mode || 'production'} 配置中识别到部署目录标识`,
  };
}
