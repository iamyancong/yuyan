/**
 * SSH 失败引导（Issue #47）。
 * @description 纯函数模块：把后端返回的 SSH 错误码转换为中文说明、可能原因与修改入口，
 * 供保存服务器、检测连接、发布、回滚、启停、扫描和发布记录统一使用。
 * 主机密钥变化不算失败（能登录就照常执行，后台自动更新指纹），因此这里没有对应条目。
 */

/** 后端 SSH 失败错误码。 */
export type SshFailureCode = 'auth_failed' | 'refused' | 'timeout' | 'unreachable' | 'sudo_unavailable' | 'ssh_error';

/** 服务器表单中可定位的字段。 */
export type SshFailureField = 'name' | 'host' | 'port' | 'username' | 'password' | 'privateKey' | 'passphrase' | 'useSudo' | '';

/** 后端返回的 SSH 失败详情。 */
export interface SshFailureInfo {
  code: SshFailureCode;
  message: string;
  reasons: string[];
  fix: string;
  field: SshFailureField;
  retryable: boolean;
  serverId?: number;
  serverName?: string;
  host?: string;
  port?: number;
}

/** 引导卡片上的修复动作。 */
export type SshFailureActionKey = 'editCredential' | 'editEndpoint' | 'editHost' | 'retry' | 'editSudo';

/** 修复动作描述。 */
export interface SshFailureAction {
  key: SshFailureActionKey;
  label: string;
  /** 打开编辑服务器时需要聚焦的字段。 */
  focusField?: SshFailureField;
  primary?: boolean;
}

/** 渲染引导卡片所需的全部信息。 */
export interface SshFailureGuide {
  code: SshFailureCode;
  title: string;
  message: string;
  reasons: string[];
  fix: string;
  hint: string;
  actions: SshFailureAction[];
  /** 是否允许直接重试同一操作。 */
  retryable: boolean;
}

/** 全部 SSH 失败错误码。 */
export const SSH_FAILURE_CODES: SshFailureCode[] = ['auth_failed', 'refused', 'timeout', 'unreachable', 'sudo_unavailable', 'ssh_error'];

/** 各错误码的默认标题、原因与修复说明（与后端 ssh-errors.mjs 保持一致）。 */
const DEFAULT_COPY: Record<SshFailureCode, { title: string; reasons: string[]; fix: string; field: SshFailureField }> = {
  auth_failed: {
    title: '登录服务器失败',
    reasons: ['服务器密码已更换', '私钥或私钥口令不对', '服务器禁用了密码登录或 root 登录'],
    fix: '在「服务器管理 → 编辑该服务器」中更新登录凭据，保存时会重新校验登录',
    field: 'password',
  },
  refused: {
    title: 'SSH 端口拒绝连接',
    reasons: ['SSH 端口填错了', 'sshd 没有启动'],
    fix: '在「服务器管理 → 编辑该服务器」中修改服务器地址或端口',
    field: 'port',
  },
  timeout: {
    title: '连不上服务器',
    reasons: ['本机没有连上内网或 VPN', 'IP 填错了', '被防火墙拦截'],
    fix: '请先确认本机已连上内网或 VPN；必要时在「服务器管理 → 编辑该服务器」中修改服务器地址',
    field: 'host',
  },
  unreachable: {
    title: '连不上服务器',
    reasons: ['本机没有连上内网或 VPN', 'IP 填错了', '被防火墙拦截'],
    fix: '请先确认本机已连上内网或 VPN；必要时在「服务器管理 → 编辑该服务器」中修改服务器地址',
    field: 'host',
  },
  sudo_unavailable: {
    title: 'sudo 不可用',
    reasons: ['没有为当前账号配置 NOPASSWD', '服务器上没有安装 sudo'],
    fix: '在「服务器管理 → 编辑该服务器」中修改「使用 sudo」设置，或在服务器上配置免密 sudo',
    field: 'useSudo',
  },
  ssh_error: {
    title: '连接服务器失败',
    reasons: ['SSH 服务异常', '网络不稳定'],
    fix: '可稍后重试，或在「服务器管理」中点「检测连接」查看详情',
    field: 'host',
  },
};

/**
 * 判断是否为 SSH 失败错误码。
 * @param code 错误码
 * @returns 是否为 SSH 失败
 */
export function isSshFailureCode(code: unknown): code is SshFailureCode {
  return SSH_FAILURE_CODES.includes(String(code || '') as SshFailureCode);
}

/**
 * 规范化后端返回的失败详情，缺省字段用默认文案补齐。
 * @param raw 后端 details / failure
 * @param fallbackMessage 外层错误消息
 * @returns 失败详情；不是 SSH 失败时返回 null
 */
export function normalizeSshFailure(raw: unknown, fallbackMessage = ''): SshFailureInfo | null {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  if (!isSshFailureCode(source.code)) return null;
  const code = source.code as SshFailureCode;
  const copy = DEFAULT_COPY[code];
  const reasons = Array.isArray(source.reasons) ? source.reasons.map((item: unknown) => String(item)).filter(Boolean) : [];
  return {
    code,
    message: String(source.message || fallbackMessage || copy.title),
    reasons: reasons.length ? reasons : copy.reasons,
    fix: String(source.fix || copy.fix),
    field: (source.field ?? copy.field) as SshFailureField,
    retryable: typeof source.retryable === 'boolean' ? source.retryable : code !== 'auth_failed',
    serverId: source.serverId ? Number(source.serverId) : undefined,
    serverName: source.serverName ? String(source.serverName) : undefined,
    host: source.host ? String(source.host) : undefined,
    port: source.port ? Number(source.port) : undefined,
  };
}

/**
 * 从任意接口错误中提取 SSH 失败详情。
 * @description 兼容 axios 错误（response.data.code/details）、流式错误（code/details/failure）和后端任务失败事件。
 * @param error 错误对象
 * @returns SSH 失败详情，无法识别时返回 null
 */
export function extractSshFailure(error: unknown): SshFailureInfo | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as Record<string, any>;
  const responseData = value.response?.data || value.data;
  const candidates = [
    value.failure,
    responseData?.details,
    responseData?.failure,
    value.details,
    responseData?.error && typeof responseData.error === 'object' ? responseData.error.details : null,
  ];
  const fallbackMessage = typeof responseData?.error === 'string' ? responseData.error : String(value.message || '');
  for (const candidate of candidates) {
    const normalized = normalizeSshFailure(candidate, fallbackMessage);
    if (normalized) return normalized;
  }
  const code = value.code && isSshFailureCode(value.code) ? value.code : responseData?.code;
  if (isSshFailureCode(code)) return normalizeSshFailure({ code }, fallbackMessage);
  if (responseData?.error && typeof responseData.error === 'object' && isSshFailureCode(responseData.error.code)) {
    return normalizeSshFailure({ ...responseData.error.details, code: responseData.error.code }, responseData.error.message);
  }
  return null;
}

/**
 * 从发布日志中还原 SSH 失败详情（发布记录抽屉使用）。
 * @param logs 发布日志，后端会在 SSH 失败日志上标记 code
 * @returns SSH 失败详情
 */
export function extractSshFailureFromLogs(logs: Array<{ level?: string; message?: string; code?: string }> = []): SshFailureInfo | null {
  const lines = logs.filter((item) => isSshFailureCode(item.code));
  if (!lines.length) return null;
  return normalizeSshFailure({ code: lines[0].code, message: lines[0].message });
}

/**
 * 生成 SSH 失败引导。
 * @param failure 失败详情
 * @returns 引导卡片数据
 */
export function getSshFailureGuide(failure: SshFailureInfo): SshFailureGuide {
  const copy = DEFAULT_COPY[failure.code] || DEFAULT_COPY.ssh_error;
  const credentialField: SshFailureField = failure.field === 'privateKey' || failure.field === 'passphrase' ? failure.field : 'password';
  let actions: SshFailureAction[] = [];
  let hint = '';
  switch (failure.code) {
    case 'auth_failed':
      actions = [{ key: 'editCredential', label: '更新登录凭据', focusField: credentialField, primary: true }];
      break;
    case 'refused':
      actions = [{ key: 'editEndpoint', label: '修改服务器地址或端口', focusField: 'port', primary: true }];
      break;
    case 'timeout':
    case 'unreachable':
      actions = [
        { key: 'retry', label: '重试', primary: true },
        { key: 'editHost', label: '修改服务器地址', focusField: 'host' },
      ];
      hint = '请先确认本机已连上内网或 VPN。';
      break;
    case 'sudo_unavailable':
      actions = [{ key: 'editSudo', label: '修改 sudo 设置', focusField: 'useSudo', primary: true }];
      break;
    default:
      actions = [{ key: 'retry', label: '重试', primary: true }];
  }
  return {
    code: failure.code,
    title: copy.title,
    message: failure.message,
    reasons: failure.reasons.length ? failure.reasons : copy.reasons,
    fix: failure.fix || copy.fix,
    hint,
    actions,
    retryable: failure.retryable,
  };
}

/** 服务器连接状态标签。 */
export interface ServerConnectionStatusTag {
  text: string;
  color: string;
  tooltip: string;
}

/**
 * 服务器列表「连接状态」标签。
 * @param server 服务器（connectionStatus / connectionCheckedAt / connectionError）
 * @param options 时间格式化
 * @returns 标签文案、颜色和提示
 */
export function getServerConnectionStatusTag(server: {
  connectionStatus?: string;
  connectionCheckedAt?: string;
  connectionError?: string;
}, options: { formatTime?: (value: string) => string } = {}): ServerConnectionStatusTag {
  const status = String(server.connectionStatus || 'unknown');
  const checkedAt = server.connectionCheckedAt ? (options.formatTime ? options.formatTime(server.connectionCheckedAt) : server.connectionCheckedAt) : '';
  const checked = checkedAt ? `最近检测：${checkedAt}` : '';
  const withError = (text: string) => [server.connectionError || text, checked].filter(Boolean).join('\n');
  switch (status) {
    case 'ok':
      return { text: '连接正常', color: 'success', tooltip: checked || '最近一次 SSH 登录成功' };
    case 'auth_failed':
      return { text: '登录失败', color: 'error', tooltip: withError('账号或密码/私钥不正确，请更新登录凭据') };
    case 'refused':
      return { text: '拒绝连接', color: 'warning', tooltip: withError('SSH 端口拒绝连接，请检查端口和 sshd') };
    case 'timeout':
      return { text: '连接超时', color: 'warning', tooltip: withError('连接超时，请确认已连上内网或 VPN') };
    case 'unreachable':
      return { text: '网络不可达', color: 'warning', tooltip: withError('网络不可达，请确认已连上内网或 VPN') };
    default:
      return { text: '未检测', color: 'default', tooltip: '还没有记录连接结果，可点「检测连接」' };
  }
}

/** Nginx 扫描状态标签。 */
export interface ScanStatusTag {
  text: string;
  color: string;
}

/**
 * 「接入已有 Nginx」扫描状态标签：扫描中 / 扫描失败 / 扫描时间。
 * @param state 扫描状态
 * @returns 标签；未扫描时返回 null
 */
export function getScanStatusTag(state: { scanning?: boolean; error?: string; scannedAt?: string; formatTime?: (value: string) => string }): ScanStatusTag | null {
  if (state.scanning) return { text: '扫描中', color: 'processing' };
  if (state.error) return { text: '扫描失败', color: 'error' };
  if (state.scannedAt) return { text: state.formatTime ? state.formatTime(state.scannedAt) : state.scannedAt, color: 'default' };
  return null;
}

/**
 * 扫描失败的中文提示：SSH 失败用统一文案，其他错误保留后端中文消息。
 * @param error 接口错误
 * @param fallback 无法识别时的提示
 * @returns 中文提示
 */
export function formatScanErrorMessage(error: unknown, fallback = '扫描失败，请稍后重试或使用手动接入'): string {
  const failure = extractSshFailure(error);
  if (failure) return failure.message;
  const value = (error || {}) as Record<string, any>;
  const responseError = value.response?.data?.error;
  const text = String((typeof responseError === 'string' ? responseError : responseError?.message) || value.message || '').trim();
  return /[\u4e00-\u9fff]/.test(text) ? text : fallback;
}
