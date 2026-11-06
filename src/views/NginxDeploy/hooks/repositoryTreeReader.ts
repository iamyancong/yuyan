/**
 * 仓库目录树感知读取模块
 * @description 在发起具体文件读取前先检查目录树，避免对不存在的文件和目录产生 404 网络请求瀑布
 */

/** 仓库条目基础结构（与 GitLab 树条目兼容） */
export interface RepositoryTreeEntry {
  name: string;
  type: 'tree' | 'blob';
}

/** 仓库文件读取函数；文件不存在时返回 null。 */
export type RepositoryFileReader = (filePath: string) => Promise<string | null>;

/** 树感知仓库读取器配置选项。 */
export interface TreeAwareRepositoryReaderOptions {
  /**
   * 列出指定目录下的直接子条目；目录不存在时返回 null。
   * @param dir 相对目录路径（根目录为 ''）
   */
  listDirectory: (dir: string) => Promise<RepositoryTreeEntry[] | null>;
  /**
   * 读取指定路径的文件文本内容；文件不存在时返回 null。
   * @param path 相对文件路径
   */
  readFile: (path: string) => Promise<string | null>;
}

/**
 * 规范化仓库相对路径为 POSIX 格式。
 * @param rawPath 原始路径
 * @returns 规范化后的 POSIX 相对路径
 */
function normalizePosixPath(rawPath: string): string {
  const normalized = String(rawPath || '').trim().replace(/\\/g, '/');
  if (!normalized || normalized === '.') return '';
  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length) segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/**
 * 从目录树条目与目标文件名列表中筛选出真实存在的 blob 完整仓库路径。
 * @param directory 所在目录（根目录传 ''）
 * @param entries 目录下的子条目列表
 * @param fileNames 期望读取的文件名列表（保持入参顺序）
 * @returns 存在的 blob 完整路径列表
 */
export function selectExistingFilePaths(
  directory: string,
  entries: Array<{ name: string; type: 'tree' | 'blob' }>,
  fileNames: string[]
): string[] {
  const normalizedDir = normalizePosixPath(directory);
  const blobNameSet = new Set<string>();
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (entry && entry.type === 'blob' && typeof entry.name === 'string') {
        blobNameSet.add(entry.name);
      }
    }
  }

  const result: string[] = [];
  for (const fileName of fileNames) {
    if (blobNameSet.has(fileName)) {
      result.push(normalizedDir ? `${normalizedDir}/${fileName}` : fileName);
    }
  }
  return result;
}

/**
 * 创建树感知的仓库文件读取函数。
 * @param options 目录列取与文件读取实现
 * @returns 具备零 404 瀑布保护的 RepositoryFileReader
 */
export function createTreeAwareRepositoryReader(
  options: TreeAwareRepositoryReaderOptions
): RepositoryFileReader {
  const dirCache = new Map<string, Promise<RepositoryTreeEntry[] | null>>();
  const fileCache = new Map<string, Promise<string | null>>();

  /**
   * 获取目录直接子项列表（带 Promise 缓存和错误清理重试支持）。
   * @param dir 规范化后的目录路径（根目录为 ''）
   */
  const getDirectoryEntries = (dir: string): Promise<RepositoryTreeEntry[] | null> => {
    const cached = dirCache.get(dir);
    if (cached) return cached;

    const promise = options.listDirectory(dir).catch((error) => {
      // 抛错时清理缓存以允许下次重试
      dirCache.delete(dir);
      throw error;
    });

    dirCache.set(dir, promise);
    return promise;
  };

  /**
   * 递归向上检查目标目录及其所有祖先目录是否存在。
   * @param dir 规范化后的目录路径
   * @returns 目录是否存在
   */
  const ensureDirectoryExists = async (dir: string): Promise<boolean> => {
    // 根目录永远存在
    if (!dir) return true;

    const lastSlashIndex = dir.lastIndexOf('/');
    const parentDir = lastSlashIndex >= 0 ? dir.slice(0, lastSlashIndex) : '';
    const currentName = lastSlashIndex >= 0 ? dir.slice(lastSlashIndex + 1) : dir;

    // 递归确保父目录存在
    const parentExists = await ensureDirectoryExists(parentDir);
    if (!parentExists) return false;

    // 父目录存在，检查父目录列表中是否包含当前目录对应的 tree 条目
    const parentEntries = await getDirectoryEntries(parentDir);
    if (!parentEntries || !Array.isArray(parentEntries)) return false;

    return parentEntries.some((entry) => entry.name === currentName && entry.type === 'tree');
  };

  /**
   * 带缓存的文件读取执行器。
   * @param filePath 规范化后的文件完整路径
   */
  const readFileWithCache = (filePath: string): Promise<string | null> => {
    const cached = fileCache.get(filePath);
    if (cached) return cached;

    const promise = options.readFile(filePath).catch((error) => {
      fileCache.delete(filePath);
      throw error;
    });

    fileCache.set(filePath, promise);
    return promise;
  };

  return async (rawPath: string): Promise<string | null> => {
    const normalizedPath = normalizePosixPath(rawPath);
    if (!normalizedPath) return null;

    const lastSlashIndex = normalizedPath.lastIndexOf('/');
    const directory = lastSlashIndex >= 0 ? normalizedPath.slice(0, lastSlashIndex) : '';
    const fileName = lastSlashIndex >= 0 ? normalizedPath.slice(lastSlashIndex + 1) : normalizedPath;

    // 检查目录是否存在（根目录 '' 永远存在，非根目录通过父目录树递归确认）
    const dirExists = await ensureDirectoryExists(directory);
    if (!dirExists) return null;

    // 目录存在，获取目录条目
    const entries = await getDirectoryEntries(directory);
    if (!entries || !Array.isArray(entries)) return null;

    // 检查文件是否为目录下的 blob
    const isBlobExists = entries.some((entry) => entry.name === fileName && entry.type === 'blob');
    if (!isBlobExists) return null;

    // 确认为真实存在的 blob 后才发起读取
    return await readFileWithCache(normalizedPath);
  };
}
