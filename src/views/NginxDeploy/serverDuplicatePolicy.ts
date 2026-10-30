/**
 * 服务器查重（Issue #47）。
 * @description 与后端 server-connection-service.mjs 的 findServerDuplicate 规则一致：
 * 同团队内 host（去首尾空格、不区分大小写）+ port + username 全部相同算重复；名称去首尾空格后相同算重名。
 * 编辑时排除自己；地址没改就不查地址、名称没改就不查名称，库里已有的重复旧记录只改无关字段时不拦。
 * 前端只用已加载的列表做即时校验，最终以后端 409 为准。
 */

/** 查重错误码。 */
export type ServerDuplicateCode = 'server_duplicate' | 'server_name_duplicate';

/** 查重所需的服务器字段。 */
export interface ServerIdentity {
  id?: number;
  name?: string;
  host?: string;
  port?: number | string;
  username?: string;
}

/** 重复详情（弹窗展示用）。 */
export interface ServerDuplicateInfo {
  code: ServerDuplicateCode;
  /** 需要标红的字段 */
  field: 'host' | 'name';
  message: string;
  existingServerId: number;
  existingServerName: string;
}

/** 规范化端口，缺省 22。 */
const normalizePort = (value: unknown) => Number(value || 22) || 22;

/** 查重用的 host：去首尾空格、不区分大小写。 */
export function normalizeServerHostKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

/** 「host + port + username」标识。 */
const endpointKey = (server: ServerIdentity) => `${normalizeServerHostKey(server.host)}|${normalizePort(server.port)}|${String(server.username ?? '').trim()}`;

/**
 * 生成与后端一致的提示文案。
 * @param code 错误码
 * @param existing 已有服务器
 * @returns 中文提示
 */
export function formatServerDuplicateMessage(code: ServerDuplicateCode, existing: ServerIdentity): string {
  const endpoint = `${existing.host}:${normalizePort(existing.port)} / ${existing.username}`;
  return code === 'server_duplicate' ? `该服务器已存在：${existing.name}（${endpoint}）` : `服务器名称已存在：${existing.name}（${endpoint}）`;
}

/**
 * 用已加载的服务器列表做即时查重。
 * @param servers 已加载的服务器
 * @param candidate 表单值
 * @param current 编辑前的服务器；新增时不传
 * @returns 重复详情，没有重复返回 null
 */
export function findServerDuplicate(servers: ServerIdentity[], candidate: ServerIdentity, current?: ServerIdentity | null): ServerDuplicateInfo | null {
  const others = servers.filter((item) => !current || Number(item.id) !== Number(current.id));
  const build = (code: ServerDuplicateCode, field: 'host' | 'name', existing: ServerIdentity): ServerDuplicateInfo => ({
    code,
    field,
    message: formatServerDuplicateMessage(code, existing),
    existingServerId: Number(existing.id || 0),
    existingServerName: String(existing.name || ''),
  });
  if (!current || endpointKey(current) !== endpointKey(candidate)) {
    const existing = others.find((item) => endpointKey(item) === endpointKey(candidate));
    if (existing) return build('server_duplicate', 'host', existing);
  }
  const name = String(candidate.name ?? '').trim();
  if (name && (!current || name !== String(current.name ?? '').trim())) {
    const existing = others.find((item) => String(item.name ?? '').trim() === name);
    if (existing) return build('server_name_duplicate', 'name', existing);
  }
  return null;
}

/**
 * 从保存接口的错误里提取后端查重结果（409 + code + details）。
 * @param error 接口错误
 * @returns 重复详情，不是查重错误返回 null
 */
export function extractServerDuplicate(error: unknown): ServerDuplicateInfo | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as Record<string, any>;
  const data = value.response?.data || value.data || {};
  const details = data.details || value.details || {};
  const code = String(details.code || data.code || value.code || '');
  if (code !== 'server_duplicate' && code !== 'server_name_duplicate') return null;
  return {
    code,
    field: code === 'server_duplicate' ? 'host' : 'name',
    message: String((typeof data.error === 'string' && data.error) || value.message || ''),
    existingServerId: Number(details.existingServerId || 0),
    existingServerName: String(details.existingServerName || ''),
  };
}
