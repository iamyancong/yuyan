/**
 * 部署目录安全与清理策略模块。
 * @description 遵循“只清理雨燕明确发布过的项，未识别项默认保留”的防御性原则，
 * 提供部署根目录规范化、风险分级、清单解析与清理规划等纯函数逻辑。
 */

export const RESERVED_DEPLOY_ENTRIES = Object.freeze(['.yuyan-backups', '.yuyan-manifests']);

/**
 * 辅助函数：连接两个 POSIX 路径。
 * @param {string} a - 基础路径
 * @param {string} b - 子路径
 * @returns {string} 连接后的路径
 */
function pathPosixJoin(a, b) {
  const cleanA = String(a || '').replace(/\/+$/, '');
  const cleanB = String(b || '').replace(/^\/+/, '');
  return `${cleanA}/${cleanB}`;
}

/**
 * 判断部署目标或项目是否为主应用。
 * @param {Object} target - 部署目标或候选项目
 * @returns {boolean} 是否为主应用
 */
export function isMainDeployProject(target) {
  const text = `${target?.projectName || ''} ${target?.projectDescription || ''}`.toLowerCase();
  return text.includes('主应用');
}

/**
 * 判断部署根目录是否为共享根目录。
 * 满足以下任一条件即视为共享根目录：
 * 1. 同一服务器下有嵌套在当前部署目录内的其他部署目标；
 * 2. 部署根目录等于所选托管 Nginx 实例的 htmlRoot；
 * 3. 项目名称或描述包含「主应用」。
 *
 * @param {Object} params - 判断参数
 * @param {Object} params.target - 当前部署目标
 * @param {Array<Object>} [params.allServerTargets=[]] - 同服务器下的全部部署目标
 * @param {Object|null} [params.nginxInstance=null] - 关联的 Nginx 实例
 * @returns {boolean} 是否为共享根目录
 */
export function isSharedDeployRoot(params = {}) {
  const { target, allServerTargets = [], nginxInstance = null } = params;
  if (!target) return false;

  // 1. 项目名称或描述含“主应用”
  if (isMainDeployProject(target)) return true;

  let normalizedRoot = '';
  try {
    normalizedRoot = normalizeDeployRootPath(target.deployRoot);
  } catch {
    normalizedRoot = String(target.deployRoot || '').trim();
  }
  if (!normalizedRoot) return false;

  // 2. deployRoot 等于所选托管 Nginx 实例的 htmlRoot
  if (nginxInstance && nginxInstance.instanceType === 'managed' && nginxInstance.htmlRoot) {
    try {
      const instanceHtmlRoot = normalizeDeployRootPath(nginxInstance.htmlRoot);
      if (normalizedRoot === instanceHtmlRoot) return true;
    } catch {}
  }

  // 3. 同服务器下有嵌套在当前部署目录内的其他部署目标
  const prefix = normalizedRoot === '/' ? '/' : `${normalizedRoot}/`;
  for (const other of allServerTargets) {
    if (Number(other.id) === Number(target.id)) continue;
    try {
      const otherRoot = normalizeDeployRootPath(other.deployRoot);
      if (otherRoot.startsWith(prefix) && otherRoot !== normalizedRoot) {
        return true;
      }
    } catch {}
  }

  return false;
}

/**
 * 规划从备份恢复部署目录的操作集合。
 * 回滚、撤销回滚、发布失败自动恢复共用该规划逻辑。
 *
 * @param {Object} params - 规划参数
 * @param {'full'|'entry-only'} [params.backupKind='full'] - 备份类型
 * @param {string[]|null} [params.backupNames=null] - 备份中记录的 .backup-names 列表，为 null 表示历史旧格式备份
 * @param {string[]} [params.backupTopEntries=[]] - 备份目录内的所有顶层项（排除元数据文件）
 * @param {string[]} [params.backupDirs=[]] - 备份目录内的顶层目录列表
 * @param {string[]} [params.backupManifestTopNames=[]] - 备份内 .manifest.txt 中的顶层项
 * @param {string[]} [params.currentManifestTopNames=[]] - 部署根当前 current.txt 清单中的顶层项
 * @param {string[]} [params.existingNames=[]] - 当前部署根目录实际存在的顶层条目
 * @param {string[]} [params.existingDirs=[]] - 当前部署根目录实际存在的顶层目录
 * @param {string[]} [params.protectedNames=[]] - 受保护的子目录列表
 * @param {string[]} [params.extraRemoveNames=[]] - 额外需要移除的条目（如发布失败自动恢复时传入本次产物顶层名）
 * @param {string[]} [params.hashedDirs=['assets']] - 带哈希的静态资源目录
 * @returns {{
 *   kind: 'full'|'entry-only',
 *   restoreNames: string[],
 *   removeNames: string[],
 *   skippedOldBackupNames: string[],
 *   warningMessage: string
 * }} 恢复规划结果
 */
export function planRestore(params = {}) {
  const {
    backupKind = 'full',
    backupNames = null,
    backupTopEntries = [],
    backupDirs = [],
    backupManifestTopNames = [],
    currentManifestTopNames = [],
    existingNames = [],
    existingDirs = [],
    protectedNames = [],
    extraRemoveNames = [],
    hashedDirs = ['assets'],
  } = params;

  const protectedSet = new Set(protectedNames.filter(isValidEntryName));
  const reservedSet = new Set(RESERVED_DEPLOY_ENTRIES);
  const existingSet = new Set(existingNames.filter(isValidEntryName));
  const existingDirsSet = new Set(existingDirs.filter(isValidEntryName));
  const backupDirsSet = new Set(backupDirs.filter(isValidEntryName));
  const hashedSet = new Set(hashedDirs.filter(isValidEntryName));

  let restoreNames = [];
  let skippedOldBackupNames = [];
  let warningMessage = '';

  const isNewFormat = Array.isArray(backupNames);
  if (isNewFormat) {
    // 新格式备份：严格等于 .backup-names 中的名字 − 当前 protected − reserved
    restoreNames = backupNames
      .filter(isValidEntryName)
      .filter((name) => !protectedSet.has(name) && !reservedSet.has(name));
  } else {
    // 旧格式备份（没有 .backup-names）
    const validBackupEntries = backupTopEntries.filter(
      (name) =>
        isValidEntryName(name) &&
        !['.backup-kind', '.backup-names', '.manifest.txt'].includes(name)
    );

    const hasBackupManifest = backupManifestTopNames.length > 0;
    const hasCurrentManifest = currentManifestTopNames.length > 0;

    if (hasBackupManifest || hasCurrentManifest) {
      const recognizedSet = new Set([
        ...backupManifestTopNames.filter(isValidEntryName),
        ...currentManifestTopNames.filter(isValidEntryName),
      ]);
      for (const name of validBackupEntries) {
        if (protectedSet.has(name) || reservedSet.has(name)) continue;
        if (recognizedSet.has(name)) {
          restoreNames.push(name);
        } else {
          skippedOldBackupNames.push(name);
        }
      }
    } else {
      // 两份清单都拿不到的分支：只恢复当前不存在的项、顶层普通文件，以及 hashedDirs；当前已存在的其他目录不动
      for (const name of validBackupEntries) {
        if (protectedSet.has(name) || reservedSet.has(name)) continue;
        if (!existingSet.has(name)) {
          // 当前不存在的项，恢复
          restoreNames.push(name);
        } else if (hashedSet.has(name)) {
          // hashedDirs（如 assets），恢复
          restoreNames.push(name);
        } else if (existingDirsSet.has(name) || backupDirsSet.has(name)) {
          // 当前已存在的其他目录不动，放入 skippedOldBackupNames
          skippedOldBackupNames.push(name);
        } else {
          // 顶层普通文件，恢复
          restoreNames.push(name);
        }
      }
      warningMessage = '旧备份未找到清单文件（.manifest.txt）且当前目录无可用清单。为避免覆盖未登记的子应用，仅恢复普通文件、静态资源与当前不存在项，已有目录已保留';
    }
  }

  // 去重恢复名单
  restoreNames = [...new Set(restoreNames)].sort();
  skippedOldBackupNames = [...new Set(skippedOldBackupNames)].sort();

  // removeNames = (restoreNames ∪ 当前清单顶层名 ∪ extraRemoveNames) ∩ existing − protected − reserved
  const candidateRemove = new Set([
    ...restoreNames,
    ...currentManifestTopNames.filter(isValidEntryName),
    ...extraRemoveNames.filter(isValidEntryName),
  ]);

  let removeNames = [];
  for (const name of candidateRemove) {
    if (
      existingSet.has(name) &&
      !protectedSet.has(name) &&
      !reservedSet.has(name)
    ) {
      // entry-only 时再排除 hashedDirs
      if (backupKind === 'entry-only' && hashedSet.has(name)) {
        continue;
      }
      removeNames.push(name);
    }
  }
  removeNames = [...new Set(removeNames)].sort();

  // 防线：旧格式备份如果 restoreNames 为空且 removeNames 非空，抛错防只删不恢复
  if (!isNewFormat && restoreNames.length === 0 && removeNames.length > 0) {
    throw new Error('旧格式备份未解析到待恢复条目，但计算出待清理条目；为避免只删不恢复导致文件丢失，已停止恢复，部署目录没有改动');
  }

  return {
    kind: backupKind,
    restoreNames,
    removeNames,
    skippedOldBackupNames,
    warningMessage,
  };
}

/**
 * 校验条目名称是否为合法单段安全名称。
 * 允许名称中包含空格（不进行 trim），但禁止空串、"."、".."、路径分隔符以及回车换行等控制字符。
 * @param {string} name - 待校验条目名称
 * @returns {boolean} 是否合法
 */
export function isValidEntryName(name) {
  if (typeof name !== 'string') return false;
  if (!name) return false;
  if (name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (/[\r\n\x00]/.test(name)) return false;
  return true;
}

/**
 * 标准化远程部署根目录路径。
 * @param {string} raw - 原始路径
 * @returns {string} 标准绝对路径
 * @throws {Error} 路径非法时抛出友好中文错误
 */
export function normalizeDeployRootPath(raw) {
  if (typeof raw !== 'string') {
    throw new Error('部署根目录必须为文本路径');
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('部署根目录不能为空');
  }
  if (/[\r\n\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error('部署根目录不能包含换行符或特殊控制字符');
  }

  const converted = trimmed.replace(/\\/g, '/');
  if (!converted.startsWith('/')) {
    throw new Error('部署根目录必须使用以 / 开头的绝对路径');
  }

  // 合并连续的斜杠
  const collapsed = converted.replace(/\/+/g, '/');
  const segments = collapsed.split('/').slice(1); // 忽略最开头的空字符串

  // 检查是否包含 . 或 .. 相对路径段
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      throw new Error('部署根目录不能包含 "." 或 ".." 相对路径段，请直接填写完整绝对路径');
    }
  }

  // 去除尾部斜杠，但保持根路径 "/"
  const stripped = collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
  return stripped;
}

/**
 * 评估部署根目录的安全风险等级。
 * @param {string} normalizedPath - 标准化后的部署路径
 * @param {Object} [options={}] - 配置选项
 * @param {string[]} [options.nginxPaths=[]] - 关联的 Nginx 关键目录列表
 * @returns {{ level: 'ok'|'warn'|'block', reason: string }} 风险等级与说明
 */
export function classifyDeployRootRisk(normalizedPath, options = {}) {
  const { nginxPaths = [] } = options;

  if (typeof normalizedPath !== 'string' || !normalizedPath.startsWith('/')) {
    return {
      level: 'block',
      reason: '部署根目录不是合法的绝对路径',
    };
  }

  // 1. 检查是否包含系统保留目录段
  const segments = normalizedPath.split('/').filter(Boolean);
  for (const seg of segments) {
    if (RESERVED_DEPLOY_ENTRIES.includes(seg)) {
      return {
        level: 'block',
        reason: `部署根目录中不能包含系统保留目录名「${seg}」，请更换为常规业务目录。`,
      };
    }
  }

  // 2. 检查与关联 Nginx 路径的重叠
  let nginxRoot = '';
  const criticalDirs = [];

  const rawNginxPaths = options.nginxPaths || options.nginxDetails || [];
  if (rawNginxPaths && typeof rawNginxPaths === 'object' && !Array.isArray(rawNginxPaths)) {
    if (rawNginxPaths.nginxRoot) {
      try {
        nginxRoot = normalizeDeployRootPath(rawNginxPaths.nginxRoot);
      } catch {}
    }
    if (Array.isArray(rawNginxPaths.criticalDirs)) {
      for (const d of rawNginxPaths.criticalDirs) {
        try {
          criticalDirs.push(normalizeDeployRootPath(d));
        } catch {}
      }
    }
  } else if (Array.isArray(rawNginxPaths)) {
    for (const d of rawNginxPaths) {
      try {
        criticalDirs.push(normalizeDeployRootPath(d));
      } catch {}
    }
  }
  if (options.nginxRoot) {
    try {
      nginxRoot = normalizeDeployRootPath(options.nginxRoot);
    } catch {}
  }
  if (Array.isArray(options.criticalDirs)) {
    for (const d of options.criticalDirs) {
      try {
        criticalDirs.push(normalizeDeployRootPath(d));
      } catch {}
    }
  }

  // 若提供了 nginxRoot，将 conf、logs、sbin 自动视作关键保护目录
  if (nginxRoot) {
    criticalDirs.push(pathPosixJoin(nginxRoot, 'conf'));
    criticalDirs.push(pathPosixJoin(nginxRoot, 'logs'));
    criticalDirs.push(pathPosixJoin(nginxRoot, 'sbin'));
  }

  // 2.1 nginxRoot 本身及其祖先目录必须 block；但其下的业务目录（如 html）允许
  if (nginxRoot) {
    if (normalizedPath === nginxRoot) {
      return {
        level: 'block',
        reason: `部署根目录不能直接指向 Nginx 运行根目录（${nginxRoot}），避免发布时误删 Nginx 自身程序或配置。建议在其下创建业务子目录（如 ${nginxRoot}/html/<应用名>）。`,
      };
    }
    if (nginxRoot.startsWith(`${normalizedPath}/`)) {
      return {
        level: 'block',
        reason: `部署根目录是 Nginx 运行根目录（${nginxRoot}）的父级目录，清空发布将导致 Nginx 运行目录被删除。建议缩小部署目录范围至具体应用子目录。`,
      };
    }
  }

  // 2.2 关键子系统与配置目录（conf, sitesDir, nginxConfDir, logs, sbin）的本身、子路径与祖先必须 block
  for (const cDir of [...new Set(criticalDirs.filter(Boolean))]) {
    if (normalizedPath === cDir) {
      return {
        level: 'block',
        reason: `部署根目录不能直接指向 Nginx 关键目录（${cDir}），避免发布时误删 Nginx 配置文件或运行日志。`,
      };
    }
    if (normalizedPath.startsWith(`${cDir}/`)) {
      return {
        level: 'block',
        reason: `部署根目录不能位于 Nginx 关键目录（${cDir}）内部，避免发布操作破坏 Nginx 服务。`,
      };
    }
    if (cDir.startsWith(`${normalizedPath}/`)) {
      return {
        level: 'block',
        reason: `部署根目录是 Nginx 关键目录（${cDir}）的父级目录，清空发布将导致 Nginx 关键文件被删除。建议缩小部署目录范围至具体应用子目录。`,
      };
    }
  }

  // 3. 根与顶层核心系统目录硬黑名单（不可覆盖）
  if (normalizedPath === '/') {
    return {
      level: 'block',
      reason: '部署根目录不能设置为系统根目录（/），否则发布清空操作将导致整个操作系统损毁。',
    };
  }

  // /root
  if (normalizedPath === '/root' || normalizedPath.startsWith('/root/')) {
    return {
      level: 'block',
      reason: '部署根目录不能使用 root 用户家目录（/root）及其子目录，请使用 /opt、/data 等公共业务目录。',
    };
  }

  // /home 与 /home/<一级>
  if (normalizedPath === '/home') {
    return {
      level: 'block',
      reason: '部署根目录不能直接使用 /home 目录，请使用具体的应用目录。',
    };
  }
  if (segments.length === 2 && segments[0] === 'home') {
    // /home/<一级>，如 /home/guest、/home/ubuntu
    return {
      level: 'block',
      reason: `部署根目录不能直接使用用户个人家目录（${normalizedPath}），避免覆盖用户配置或私钥。建议在其下建立单独的应用子目录（如 ${normalizedPath}/<应用名>）。`,
    };
  }

  // /opt 本身禁
  if (normalizedPath === '/opt') {
    return {
      level: 'block',
      reason: '部署根目录不能直接使用 /opt 顶层目录，请使用如 /opt/yuyan/html/<应用名> 的独立子目录。',
    };
  }

  // /usr 及其子路径规则
  if (normalizedPath === '/usr' || normalizedPath.startsWith('/usr/')) {
    // 3.1 block 本身
    if (['/usr', '/usr/local', '/usr/share', '/usr/share/nginx'].includes(normalizedPath)) {
      return {
        level: 'block',
        reason: `部署根目录不能直接使用系统目录（${normalizedPath}）。`,
      };
    }

    // 3.2 block 系统二进制与库目录及其所有子路径
    const usrStrictPrefixes = [
      '/usr/bin',
      '/usr/sbin',
      '/usr/lib',
      '/usr/lib64',
      '/usr/lib32',
      '/usr/libexec',
      '/usr/include',
      '/usr/src',
      '/usr/local/bin',
      '/usr/local/sbin',
      '/usr/local/lib',
      '/usr/local/lib64',
      '/usr/local/include',
      '/usr/local/etc',
      '/usr/local/share',
    ];
    for (const prefix of usrStrictPrefixes) {
      if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) {
        return {
          level: 'block',
          reason: `部署根目录不能使用系统软件或核心库目录（${normalizedPath}）。`,
        };
      }
    }

    // 3.3 /usr/share/<x>：除 /usr/share/nginx/html 及其子目录外全部 block
    if (normalizedPath.startsWith('/usr/share/')) {
      const allowedNginxHtml = '/usr/share/nginx/html';
      const isAllowed = normalizedPath === allowedNginxHtml || normalizedPath.startsWith(`${allowedNginxHtml}/`);
      if (!isAllowed) {
        return {
          level: 'block',
          reason: `部署根目录不能使用系统共享数据目录（${normalizedPath}）。若需使用系统默认 Web 目录，仅支持 ${allowedNginxHtml} 及其子目录。`,
        };
      }
      return {
        level: 'ok',
        reason: '',
      };
    }

    // 3.4 /usr/local/<x> 分级
    if (normalizedPath.startsWith('/usr/local/')) {
      // segments: ['usr', 'local', '<x>', ...]
      if (segments.length === 3) {
        // /usr/local/<x>（如 /usr/local/nginx）warn
        return {
          level: 'warn',
          reason: `部署根目录「${normalizedPath}」层级较浅，可能包含软件自身运行文件。建议使用如 ${normalizedPath}/html 的独立业务子目录。`,
        };
      }
      // segments.length >= 4（如 /usr/local/nginx/html）ok
      return {
        level: 'ok',
        reason: '',
      };
    }

    // 3.5 其他位于 /usr/ 下的顶层目录（如 /usr/games 等）block
    return {
      level: 'block',
      reason: `部署根目录不能直接使用系统目录（${normalizedPath}）。`,
    };
  }

  // /etc 及子路径
  if (normalizedPath === '/etc' || normalizedPath.startsWith('/etc/')) {
    return {
      level: 'block',
      reason: '部署根目录不能使用系统配置目录（/etc）及其子目录，避免发布导致系统或服务配置丢失。',
    };
  }

  // /var, /var/lib, /var/www（只禁本身）
  if (normalizedPath === '/var') {
    return {
      level: 'block',
      reason: '部署根目录不能直接使用 /var 顶层目录，请使用更深层的独立业务目录。',
    };
  }
  if (normalizedPath === '/var/lib' || normalizedPath.startsWith('/var/lib/')) {
    return {
      level: 'block',
      reason: '部署根目录不能使用系统状态与数据库运行目录（/var/lib）及其子路径。',
    };
  }
  if (normalizedPath === '/var/www') {
    return {
      level: 'block',
      reason: '部署根目录不能直接使用 /var/www 本身，建议在下面创建具体的应用子目录（例如 /var/www/<应用名>）。',
    };
  }

  // 只禁本身的系统目录
  const blockExactOnly = new Set([
    '/bin',
    '/sbin',
    '/lib',
    '/lib64',
    '/lib32',
    '/boot',
    '/dev',
    '/proc',
    '/sys',
    '/run',
    '/tmp',
    '/srv',
    '/mnt',
    '/media',
    '/data',
  ]);
  if (blockExactOnly.has(normalizedPath)) {
    return {
      level: 'block',
      reason: `部署根目录不能直接使用系统根级目录「${normalizedPath}」，请在其中指定专用的业务子目录。`,
    };
  }

  // 任何位于 /bin, /sbin, /lib, /lib64, /lib32, /boot, /dev, /proc, /sys, /run 的子目录也是硬禁止的
  const strictSystemPrefixes = ['/bin/', '/sbin/', '/lib/', '/lib64/', '/lib32/', '/boot/', '/dev/', '/proc/', '/sys/', '/run/'];
  for (const prefix of strictSystemPrefixes) {
    if (normalizedPath.startsWith(prefix)) {
      return {
        level: 'block',
        reason: `部署根目录不能位于系统基础运行目录（${normalizedPath}）内。`,
      };
    }
  }

  // 4. warn（软名单，确认后可继续）：
  // 只有两段的路径，如 /opt/<x>、/srv/<x>、/data/<x>、/var/<x>（未被 block 的）、/mnt/<x>、/home/<x>/<y>
  if (segments.length === 2) {
    return {
      level: 'warn',
      reason: `部署根目录「${normalizedPath}」层级较浅（仅包含两级路径），如果目录中有其他应用或文件，清空操作可能存在风险。建议使用如 ${normalizedPath}/<应用名> 的独立专属目录。`,
    };
  }
  if (segments.length === 3 && segments[0] === 'home') {
    return {
      level: 'warn',
      reason: `部署根目录「${normalizedPath}」位于用户家目录的直接子级，清空操作可能影响该目录下的其他文件。请确认该目录仅由本应用独占使用。`,
    };
  }

  return {
    level: 'ok',
    reason: '',
  };
}

/**
 * 从清单文本提取顶层目录或文件名。
 * @param {string} text - 清单文件内容
 * @returns {string[]} 去重并排序的顶层名称列表
 */
export function manifestTopNames(text) {
  if (!text || typeof text !== 'string') return [];
  const names = new Set();
  const lines = text.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('/')) continue;
    const parts = line.split('/');
    if (parts.includes('..') || parts.includes('.')) continue;
    const top = parts[0];
    if (isValidEntryName(top)) {
      names.add(top);
    }
  }
  return [...names].sort();
}

/**
 * 过滤发布清单中的相对路径列表，严格排除顶层为受保护子目录或系统保留目录的项。
 * 确保受保护子目录下的文件绝不记入雨燕发布清单，避免未来发布被误删。
 *
 * @param {string[]} [relativeFiles=[]] - 待过滤的文件相对路径列表
 * @param {string[]} [protectedSubDirs=[]] - 受保护的子目录名称列表
 * @returns {string[]} 过滤后的安全相对路径列表
 */
export function filterManifestRelativeFiles(relativeFiles = [], protectedSubDirs = []) {
  if (!Array.isArray(relativeFiles)) return [];
  const protectedSet = new Set(protectedSubDirs.filter(isValidEntryName));
  const reservedSet = new Set(RESERVED_DEPLOY_ENTRIES);

  return relativeFiles.filter((relPath) => {
    if (typeof relPath !== 'string') return false;
    const trimmed = relPath.trim();
    if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('\\')) return false;
    const normalized = trimmed.replace(/\\/g, '/');
    const parts = normalized.split('/');
    if (parts.includes('..') || parts.includes('.')) return false;
    const top = parts[0];
    if (!isValidEntryName(top)) return false;
    if (protectedSet.has(top) || reservedSet.has(top)) return false;
    return true;
  });
}

/**
 * 计算部署清理计划。
 * 核心原则：只删除雨燕能证明是自己发布过的顶层项，未识别项默认保留。
 *
 * @param {Object} params - 计算参数
 * @param {string[]} [params.existingNames=[]] - 目标服务器部署根下实际存在的顶层条目
 * @param {string[]} [params.artifactTopNames=[]] - 本次构建产物的顶层条目
 * @param {string[]} [params.manifestTopNames=[]] - 上次发布清单中记录的顶层条目
 * @param {string[]} [params.protectedNames=[]] - 受保护的子目录/文件名（嵌套目标 + 手填保留）
 * @param {string[]} [params.extraCleanupNames=[]] - 用户在确认界面主动勾选额外清理的未识别项
 * @param {'cleanReplace'|'overlayKeepAssets'} [params.mode='cleanReplace'] - 资源策略
 * @returns {{
 *   deleteNames: string[],
 *   keptProtected: string[],
 *   keptUnknown: string[],
 *   keptReserved: string[],
 *   rejectedExtra: string[]
 * }} 清理规划结果
 */
export function computeCleanupPlan(params = {}) {
  const {
    existingNames = [],
    artifactTopNames = [],
    manifestTopNames = [],
    protectedNames = [],
    extraCleanupNames = [],
  } = params;

  const validExisting = [...new Set(existingNames.filter(isValidEntryName))].sort();
  const existingSet = new Set(validExisting);
  const protectedSet = new Set(protectedNames.filter(isValidEntryName));
  const reservedSet = new Set(RESERVED_DEPLOY_ENTRIES);

  const validArtifact = [...new Set(artifactTopNames.filter(isValidEntryName))];
  const validManifest = [...new Set(manifestTopNames.filter(isValidEntryName))];

  const artifactSet = new Set(validArtifact);
  const manifestSet = new Set(validManifest);

  // 判断是否属于“未识别项”：已存在 - 保护 - 系统保留 - 本次产物 - 上次清单
  const isUnknown = (name) =>
    existingSet.has(name) &&
    !protectedSet.has(name) &&
    !reservedSet.has(name) &&
    !artifactSet.has(name) &&
    !manifestSet.has(name);

  // extraCleanupNames 只有在它属于“未识别项”时才合法，其余进 rejectedExtra
  const validExtraNames = [];
  const rejectedExtra = [];
  for (const name of extraCleanupNames) {
    if (isValidEntryName(name) && isUnknown(name)) {
      validExtraNames.push(name);
    } else {
      rejectedExtra.push(name);
    }
  }

  // 待删除候选 = 本次产物 ∪ 上次清单 ∪ 合法额外清理项
  const candidateDeleteSet = new Set([...validArtifact, ...validManifest, ...validExtraNames]);

  // deleteNames = candidateDelete ∩ existing − protected − reserved
  const deleteNames = [];
  for (const name of validExisting) {
    if (candidateDeleteSet.has(name) && !protectedSet.has(name) && !reservedSet.has(name)) {
      deleteNames.push(name);
    }
  }

  const deleteSet = new Set(deleteNames);

  // keptProtected = existing ∩ protected
  const keptProtected = validExisting.filter((name) => protectedSet.has(name));

  // keptReserved = existing ∩ reserved
  const keptReserved = validExisting.filter((name) => reservedSet.has(name));

  // keptUnknown = existing − protected − reserved − deleteNames
  const keptUnknown = validExisting.filter(
    (name) => !protectedSet.has(name) && !reservedSet.has(name) && !deleteSet.has(name)
  );

  return {
    deleteNames: deleteNames.sort(),
    keptProtected: keptProtected.sort(),
    keptUnknown: keptUnknown.sort(),
    keptReserved: keptReserved.sort(),
    rejectedExtra: [...new Set(rejectedExtra)].sort(),
  };
}
