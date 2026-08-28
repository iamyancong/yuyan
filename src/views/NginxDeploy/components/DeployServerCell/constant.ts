/**
 * 获取服务器展示名称。
 * @param serverName 服务器名称
 * @param serverHost 服务器 IP / 域名
 * @returns 服务器名称
 */
export const getServerTitle = (serverName?: string | null, serverHost?: string | null): string => {
  const name = String(serverName || '').trim();
  if (name) return name;
  const host = String(serverHost || '').trim();
  return host || '-';
};

/**
 * 获取服务器副文本（IP 或主机地址）。
 * @param serverName 服务器名称
 * @param serverHost 服务器 IP / 域名
 * @returns 服务器副文本
 */
export const getServerSubtitle = (serverName?: string | null, serverHost?: string | null): string => {
  const host = String(serverHost || '').trim();
  const name = String(serverName || '').trim();
  if (host && name && host !== name) {
    return host;
  }
  return '';
};
