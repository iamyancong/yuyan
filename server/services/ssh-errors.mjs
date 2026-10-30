/**
 * SSH 连接失败分类与中文引导。
 * @description 所有 SSH 入口（保存服务器、检测连接、发布、回滚、启停、扫描）共用同一套错误码，
 * 前端 `getSshFailureGuide` 与本文件的文案保持一致（Issue #47）。
 * 主机密钥变化不算失败：能登录就照常执行，并自动更新指纹（见 ssh-service.connectSsh）。
 */

import crypto from 'node:crypto';

/** SSH 连接阶段失败的稳定错误码。 */
export const SSH_FAILURE_CODES = Object.freeze({
  authFailed: 'auth_failed',
  refused: 'refused',
  timeout: 'timeout',
  unreachable: 'unreachable',
  sudoUnavailable: 'sudo_unavailable',
  unknown: 'ssh_error',
});

/** 全部 SSH 失败错误码集合。 */
const SSH_FAILURE_CODE_SET = new Set(Object.values(SSH_FAILURE_CODES));

/** 会被回写为服务器连接状态的错误码。 */
export const SSH_CONNECTION_STATUS_CODES = new Set(['auth_failed', 'refused', 'timeout', 'unreachable']);

/** 各错误码对应的表单字段，用于前端定位。 */
const SSH_FAILURE_FIELDS = {
  auth_failed: 'password',
  refused: 'port',
  timeout: 'host',
  unreachable: 'host',
  sudo_unavailable: 'useSudo',
  ssh_error: 'host',
};

/**
 * 判断错误码是否属于 SSH 连接阶段失败。
 * @param {string} code - 错误码
 * @returns {boolean} 是否为 SSH 失败
 */
export function isSshFailureCode(code) {
  return SSH_FAILURE_CODE_SET.has(String(code || ''));
}

/**
 * 按 OpenSSH `ssh-keygen -lf` 的格式生成主机公钥指纹。
 * @param {Buffer|string} key - ssh2 hostVerifier 收到的原始公钥
 * @returns {string} 形如 `SHA256:xxxx` 的指纹
 */
export function formatHostKeyFingerprint(key) {
  const buffer = Buffer.isBuffer(key) ? key : Buffer.from(String(key || ''), 'utf8');
  return `SHA256:${crypto.createHash('sha256').update(buffer).digest('base64').replace(/=+$/, '')}`;
}

/**
 * 规范化已保存的指纹文本。
 * @param {string} value - 原始指纹
 * @returns {string} 规范化指纹，非法时为空
 */
export function normalizeHostKeyFingerprint(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const body = text.replace(/^SHA256:/i, '').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]{43}$/.test(body)) return '';
  return `SHA256:${body}`;
}

/**
 * 根据 ssh2 / socket 错误判断失败类别。
 * @param {unknown} error - 原始错误
 * @returns {string} 错误码
 */
export function classifySshError(error) {
  if (error && typeof error === 'object' && isSshFailureCode(error.code) && error.name === 'SshConnectionError') return error.code;
  const level = String(error?.level || '');
  const code = String(error?.code || '');
  const message = String(error?.message || error || '');
  if (level === 'client-authentication'
    || /all configured authentication methods failed|authentication failed|permission denied \(|cannot parse privatekey|privatekey value|encrypted private ?key|bad passphrase/i.test(message)) {
    return SSH_FAILURE_CODES.authFailed;
  }
  if (code === 'ECONNREFUSED' || /ECONNREFUSED|connection refused/i.test(message)) return SSH_FAILURE_CODES.refused;
  if (level === 'client-timeout' || code === 'ETIMEDOUT' || /timed out while waiting for handshake|ETIMEDOUT|timed out/i.test(message)) {
    return SSH_FAILURE_CODES.timeout;
  }
  if (['ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN'].includes(code)
    || /ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|getaddrinfo|no route to host|network is unreachable/i.test(message)) {
    return SSH_FAILURE_CODES.unreachable;
  }
  return SSH_FAILURE_CODES.unknown;
}

/**
 * 生成 SSH 失败的中文提示、可能原因与修改入口说明。
 * @param {string} code - 错误码
 * @param {{serverName?: string, host?: string, port?: number}} context - 服务器信息
 * @returns {{message: string, reasons: string[], fix: string}} 中文说明
 */
export function describeSshFailure(code, context = {}) {
  const name = String(context.serverName || context.host || '').trim() || '目标服务器';
  switch (code) {
    case SSH_FAILURE_CODES.authFailed:
      return {
        message: `登录服务器「${name}」失败：账号或密码/私钥不正确`,
        reasons: ['服务器密码已更换', '私钥或私钥口令不对', '服务器禁用了密码登录或 root 登录'],
        fix: '在「服务器管理 → 编辑该服务器」中更新登录凭据，保存时会重新校验登录',
      };
    case SSH_FAILURE_CODES.refused:
      return {
        message: `服务器「${name}」的 SSH 端口拒绝连接`,
        reasons: ['SSH 端口填错了', 'sshd 没有启动'],
        fix: '在「服务器管理 → 编辑该服务器」中修改服务器地址或端口',
      };
    case SSH_FAILURE_CODES.timeout:
    case SSH_FAILURE_CODES.unreachable:
      return {
        message: `连不上服务器「${name}」`,
        reasons: ['本机没有连上内网或 VPN', 'IP 填错了', '被防火墙拦截'],
        fix: '请先确认本机已连上内网或 VPN；必要时在「服务器管理 → 编辑该服务器」中修改服务器地址',
      };
    case SSH_FAILURE_CODES.sudoUnavailable:
      return {
        message: `服务器「${name}」开启了 sudo，但 sudo 不可用或需要密码`,
        reasons: ['没有为当前账号配置 NOPASSWD', '服务器上没有安装 sudo'],
        fix: '在「服务器管理 → 编辑该服务器」中修改「使用 sudo」设置，或在服务器上配置免密 sudo',
      };
    default:
      return {
        message: `连接服务器「${name}」失败`,
        reasons: ['SSH 服务异常', '网络不稳定'],
        fix: '可稍后重试，或在「服务器管理」中点「检测连接」查看详情',
      };
  }
}

/** SSH 连接阶段失败。 */
export class SshConnectionError extends Error {
  /**
   * @param {string} code - 错误码
   * @param {{serverId?: number, serverName?: string, host?: string, port?: number, cause?: unknown, status?: number}} context - 上下文
   */
  constructor(code, context = {}) {
    const description = describeSshFailure(code, context);
    super(description.message);
    this.name = 'SshConnectionError';
    this.code = code;
    this.status = Number(context.status || 422);
    this.serverId = Number(context.serverId || 0) || null;
    this.serverName = String(context.serverName || '');
    this.host = String(context.host || '');
    this.port = Number(context.port || 22);
    this.reasons = description.reasons;
    this.fix = description.fix;
    this.field = SSH_FAILURE_FIELDS[code] ?? '';
    this.rawMessage = context.cause ? String(context.cause?.message || context.cause) : '';
    this.retryable = code !== SSH_FAILURE_CODES.authFailed;
    this.details = this.toJSON();
  }

  /**
   * 序列化给前端与任务快照。
   * @returns {Object} 失败详情
   */
  toJSON() {
    return {
      code: this.code,
      serverId: this.serverId,
      serverName: this.serverName,
      host: this.host,
      port: this.port,
      field: this.field,
      reasons: this.reasons,
      fix: this.fix,
      rawMessage: this.rawMessage,
      retryable: this.retryable,
    };
  }
}

/**
 * 判断错误是否为 SSH 连接阶段失败。
 * @param {unknown} error - 错误
 * @returns {boolean} 是否为 SshConnectionError
 */
export function isSshConnectionError(error) {
  return Boolean(error && typeof error === 'object' && error.name === 'SshConnectionError' && isSshFailureCode(error.code));
}

/**
 * 将任意 SSH 原始错误包装为带错误码的 SshConnectionError。
 * @param {unknown} error - 原始错误
 * @param {Object} server - 服务器信息
 * @returns {SshConnectionError} 包装后的错误
 */
export function toSshConnectionError(error, server = {}) {
  if (isSshConnectionError(error)) return error;
  return new SshConnectionError(classifySshError(error), {
    serverId: server.id,
    serverName: server.name,
    host: server.host,
    port: server.port,
    cause: error,
  });
}

/**
 * 生成发布日志中的 SSH 失败说明（多行）。
 * @param {SshConnectionError} error - SSH 失败
 * @returns {string[]} 日志行
 */
export function formatSshFailureLogLines(error) {
  const lines = [`${error.message}`, `可能原因：${error.reasons.join('；')}`, `修改入口：${error.fix}`];
  if (error.rawMessage && error.rawMessage !== error.message) lines.push(`原始错误：${error.rawMessage}`);
  return lines;
}

/**
 * 写入失败日志：SSH 失败输出带错误码的多行中文说明，其他错误保持原样。
 * @param {(level: string, message: string, stage?: string, source?: string, extra?: Object) => void} log - 日志函数
 * @param {unknown} error - 失败原因
 * @param {string} stage - 日志阶段
 */
export function logOperationFailure(log, error, stage = 'error') {
  if (!isSshConnectionError(error)) {
    log('error', error instanceof Error ? error.message : String(error), stage);
    return;
  }
  formatSshFailureLogLines(error).forEach((line) => log('error', line, stage, '', { code: error.code }));
}

/**
 * 生成任务 error 事件附加字段。
 * @param {unknown} error - 失败原因
 * @returns {{code?: string, failure?: Object}} 附加字段
 */
export function getSshFailureEventExtra(error) {
  return isSshConnectionError(error) ? { code: error.code, failure: error.toJSON() } : {};
}
