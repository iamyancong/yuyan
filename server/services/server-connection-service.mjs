/**
 * 服务器 SSH 登录校验服务（Issue #47）。
 * @description 新增/编辑服务器在写库之前必须 SSH 登录成功。主机指纹只记录不拦截：能登录就照常保存，指纹变化自动更新并留审计。
 * 校验函数通过 `dependencies.probe` 注入探测器，便于单测绕过真实连接；生产入口不传依赖，无法关闭校验。
 */

import {
  createServer,
  getServerWithCredential,
  hasServerCredentialPayload,
  listServerIdentities,
  normalizeServerCredentialPayload,
  recordServerConnectionResult,
  updateServer,
} from './deploy-store.mjs';
import { isSshConnectionError, normalizeHostKeyFingerprint, toSshConnectionError } from './ssh-errors.mjs';
import { probeServerConnection } from './ssh-service.mjs';

/**
 * 规范化端口。
 * @param {*} value - 原始端口
 * @returns {number} 端口
 */
function normalizePort(value) {
  return Number(value || 22) || 22;
}

/**
 * 查重用的 host：去首尾空格、不区分大小写。
 * @param {*} value - 原始 host
 * @returns {string} 规范化 host
 */
export function normalizeServerHostKey(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * 查重用的「host + port + username」标识。
 * @param {{host?: string, port?: *, username?: string}} server - 服务器
 * @returns {string} 标识
 */
function getServerEndpointKey(server) {
  return `${normalizeServerHostKey(server.host)}|${normalizePort(server.port)}|${String(server.username ?? '').trim()}`;
}

/**
 * 在同团队服务器中查找与待保存服务器重复的记录（纯函数）。
 * @description host（trim + 不区分大小写）+ port + username 全部相同算地址重复；名称 trim 后相同算名称重复。
 * 编辑时排除自己；只有 host / port / username 真正变化时才查地址重复、名称变化时才查名称重复，
 * 因此库里已有的重复旧记录只改无关字段时不拦。
 * @param {Array<{id: number, name: string, host: string, port: number, username: string}>} servers - 同团队服务器
 * @param {{name?: string, host?: string, port?: *, username?: string}} candidate - 待保存的服务器（编辑时为合并后的最终值）
 * @param {Object|null} current - 编辑前的服务器；新增时为 null
 * @returns {{code: 'server_duplicate'|'server_name_duplicate', field: 'host'|'name', server: Object}|null} 重复信息
 */
export function findServerDuplicate(servers, candidate, current = null) {
  const others = servers.filter((item) => !current || Number(item.id) !== Number(current.id));
  const endpointChanged = !current || getServerEndpointKey(current) !== getServerEndpointKey(candidate);
  if (endpointChanged) {
    const key = getServerEndpointKey(candidate);
    const existing = others.find((item) => getServerEndpointKey(item) === key);
    if (existing) return { code: 'server_duplicate', field: 'host', server: existing };
  }
  const name = String(candidate.name ?? '').trim();
  const nameChanged = !current || name !== String(current.name ?? '').trim();
  if (name && nameChanged) {
    const existing = others.find((item) => String(item.name ?? '').trim() === name);
    if (existing) return { code: 'server_name_duplicate', field: 'name', server: existing };
  }
  return null;
}

/**
 * 生成查重失败的 409 错误。
 * @param {{code: string, field: string, server: Object}} duplicate - 重复信息
 * @returns {Error} 带 status / code / details 的错误
 */
function createDuplicateError(duplicate) {
  const existing = duplicate.server;
  const endpoint = `${existing.host}:${normalizePort(existing.port)} / ${existing.username}`;
  const message = duplicate.code === 'server_duplicate'
    ? `该服务器已存在：${existing.name}（${endpoint}）`
    : `服务器名称已存在：${existing.name}（${endpoint}）`;
  return Object.assign(new Error(message), {
    status: 409,
    code: duplicate.code,
    details: {
      code: duplicate.code,
      field: duplicate.field,
      existingServerId: Number(existing.id),
      existingServerName: existing.name,
      host: existing.host,
      port: normalizePort(existing.port),
      username: existing.username,
    },
  });
}

/**
 * 保存前查重：重复时直接抛 409，不发起 SSH 登录。
 * @param {Object} candidate - 待保存的服务器
 * @param {Object|null} current - 编辑前的服务器
 */
async function assertServerNotDuplicate(candidate, current = null) {
  const duplicate = findServerDuplicate(await listServerIdentities(), candidate, current);
  if (duplicate) throw createDuplicateError(duplicate);
}

/**
 * 计算编辑服务器时需要重新做哪些校验。
 * @description host、port、username、authType 变化或重新填写了密码/私钥/口令时重新校验登录；
 * 只改 useSudo 时只检查 sudo；只改名称、备注、默认路径等不校验。
 * @param {Object} current - 当前服务器（getServerWithCredential 结果）
 * @param {Object} payload - 更新参数
 * @returns {{login: boolean, sudo: boolean, changedFields: string[]}} 校验计划
 */
export function resolveServerVerificationPlan(current, payload = {}) {
  const changedFields = [];
  const compareText = (field) => {
    if (payload[field] === undefined) return;
    if (String(payload[field] ?? '').trim() !== String(current[field] ?? '').trim()) changedFields.push(field);
  };
  compareText('host');
  compareText('username');
  if (payload.port !== undefined && normalizePort(payload.port) !== normalizePort(current.port)) changedFields.push('port');
  if (payload.authType !== undefined && String(payload.authType || 'password') !== String(current.authType || 'password')) changedFields.push('authType');
  if (hasServerCredentialPayload(payload)) changedFields.push('credential');
  const sudoChanged = payload.useSudo !== undefined && Boolean(payload.useSudo) !== Boolean(current.useSudo);
  return {
    login: changedFields.length > 0,
    sudo: sudoChanged,
    changedFields,
  };
}

/**
 * 将探测失败包装为保存接口返回的 422 错误，并按认证方式修正定位字段。
 * @param {unknown} error - 原始错误
 * @param {Object} candidate - 待保存的服务器
 * @returns {SshConnectionError} 保存错误
 */
function toSaveError(error, candidate) {
  const sshError = toSshConnectionError(error, candidate);
  sshError.status = 422;
  if (sshError.code === 'auth_failed' && candidate.authType === 'privateKey') sshError.field = 'privateKey';
  sshError.details = { ...sshError.toJSON(), field: sshError.field };
  return sshError;
}

/**
 * 生成探测结果摘要（返回给前端）。
 * @param {Object|null} result - 探测结果
 * @param {{checked: boolean, warnings?: string[]}} extra - 补充信息
 * @returns {Object} 校验摘要
 */
function buildVerificationSummary(result, extra) {
  const warnings = [...(extra.warnings || [])];
  if (result?.sudo?.checked && !result.sudo.ok) warnings.push(result.sudo.message);
  return {
    checked: extra.checked,
    account: result?.account || '',
    hostKeySha256: result?.hostKeySha256 || '',
    sudo: result?.sudo || { checked: false, ok: true, message: '' },
    warnings,
  };
}

/**
 * 新增服务器：SSH 登录成功后才写库，并记录主机指纹（只记不拦）。
 * @param {Object} payload - 服务器参数
 * @param {{probe?: Function}} dependencies - 可替换探测器（仅测试）
 * @returns {Promise<Object>} 新增后的服务器（含 verification）
 */
export async function createServerWithVerification(payload, dependencies = {}) {
  const probe = dependencies.probe || probeServerConnection;
  const credential = normalizeServerCredentialPayload(payload);
  const candidate = {
    name: String(payload.name || '').trim(),
    host: String(payload.host || '').trim(),
    port: normalizePort(payload.port),
    username: String(payload.username || '').trim(),
    authType: payload.authType === 'privateKey' ? 'privateKey' : 'password',
    useSudo: Boolean(payload.useSudo),
    credential,
  };
  // 查重在 SSH 登录之前：重复就不发起登录。
  await assertServerNotDuplicate(candidate);
  let result;
  try {
    result = await probe(candidate, { useSudo: candidate.useSudo, persist: false });
  } catch (error) {
    throw toSaveError(error, candidate);
  }
  // 登录期间可能有人并发新增了同一台，写库前再查一次（只查库，不再登录）。
  await assertServerNotDuplicate(candidate);
  const server = await createServer({
    ...payload,
    ...credential,
    hostKeySha256: result?.hostKeySha256 || '',
    connectionStatus: 'ok',
  });
  return { ...server, verification: buildVerificationSummary(result, { checked: true }) };
}

/**
 * 编辑服务器：按变更内容决定是否重新校验登录，校验失败不写库。
 * @param {number} id - 服务器 ID
 * @param {Object} payload - 更新参数
 * @param {{probe?: Function}} dependencies - 可替换探测器（仅测试）
 * @returns {Promise<Object|null>} 更新后的服务器（含 verification）
 */
export async function updateServerWithVerification(id, payload, dependencies = {}) {
  const probe = dependencies.probe || probeServerConnection;
  const current = await getServerWithCredential(id);
  if (!current) return null;
  const plan = resolveServerVerificationPlan(current, payload);
  // 查重在 SSH 登录之前，编辑时排除自己；只改名称也查名称。
  await assertServerNotDuplicate({
    name: payload.name !== undefined ? String(payload.name || '').trim() : current.name,
    host: payload.host !== undefined ? String(payload.host || '').trim() : current.host,
    port: normalizePort(payload.port ?? current.port),
    username: payload.username !== undefined ? String(payload.username || '').trim() : current.username,
  }, current);
  if (!plan.login && !plan.sudo) {
    const server = await updateServer(id, payload);
    return server ? { ...server, verification: buildVerificationSummary(null, { checked: false }) } : null;
  }

  const credential = hasServerCredentialPayload(payload) ? normalizeServerCredentialPayload(payload) : current.credential;
  const candidate = {
    id: current.id,
    name: payload.name !== undefined ? String(payload.name || '').trim() : current.name,
    host: payload.host !== undefined ? String(payload.host || '').trim() : current.host,
    port: normalizePort(payload.port ?? current.port),
    username: payload.username !== undefined ? String(payload.username || '').trim() : current.username,
    authType: (payload.authType || current.authType) === 'privateKey' ? 'privateKey' : 'password',
    useSudo: payload.useSudo !== undefined ? Boolean(payload.useSudo) : Boolean(current.useSudo),
    credential,
  };

  if (!plan.login) {
    // 只改了 useSudo：重新检查 sudo，结果只作为提示，不拦保存。
    let result = null;
    const warnings = [];
    try {
      result = await probe(candidate, { useSudo: candidate.useSudo, persist: false });
    } catch (error) {
      warnings.push(`未能重新检查 sudo：${toSshConnectionError(error, candidate).message}`);
    }
    const server = await updateServer(id, payload);
    return server ? { ...server, verification: buildVerificationSummary(result, { checked: Boolean(result), warnings }) } : null;
  }

  let result;
  try {
    result = await probe(candidate, { useSudo: candidate.useSudo, persist: false });
  } catch (error) {
    throw toSaveError(error, candidate);
  }
  await assertServerNotDuplicate(candidate, current);
  // 登录成功即保存；指纹与已存不同时由存储层自动更新并写 auto_updated 审计。
  const verifiedFingerprint = normalizeHostKeyFingerprint(result?.hostKeySha256);
  const server = await updateServer(id, {
    ...payload,
    ...(hasServerCredentialPayload(payload) ? credential : {}),
    connectionStatus: 'ok',
    connectionError: '',
    ...(verifiedFingerprint ? { hostKeySha256: verifiedFingerprint } : {}),
  });
  return server ? { ...server, verification: buildVerificationSummary(result, { checked: true }) } : null;
}

/**
 * 「检测连接」：用已保存凭据登录，回写连接状态；指纹首次记录或变化后自动更新由 connectSsh 钩子完成。
 * @param {number} serverId - 服务器 ID
 * @param {{probe?: Function}} dependencies - 可替换探测器（仅测试）
 * @returns {Promise<{success: boolean, output: string, account: string, sudo: Object}>} 检测结果
 */
export async function testSavedServerConnection(serverId, dependencies = {}) {
  const probe = dependencies.probe || probeServerConnection;
  const server = await getServerWithCredential(serverId);
  if (!server) throw Object.assign(new Error('服务器不存在'), { status: 404 });
  try {
    const result = await probe(server, { useSudo: Boolean(server.useSudo), persist: true });
    await recordServerConnectionResult(server.id, { ok: true }, { force: true });
    return {
      success: true,
      output: result?.output || '',
      account: result?.account || '',
      sudo: result?.sudo || { checked: false, ok: true, message: '' },
    };
  } catch (error) {
    const sshError = toSshConnectionError(error, server);
    if (dependencies.probe) {
      // 注入探测器不会经过 connectSsh 钩子，这里补齐状态回写，保持与真实连接一致。
      await recordServerConnectionResult(server.id, { ok: false, code: sshError.code, message: sshError.message });
    }
    throw sshError;
  }
}

export { isSshConnectionError };
