/**
 * 校验创建 GitLab 仓库所需的配置。
 * @param {Object} options 创建参数
 * @param {boolean} options.createRepo 是否创建远程仓库
 * @param {unknown} options.gitlabHost GitLab Host
 * @param {unknown} options.gitlabToken GitLab Token
 * @param {unknown} options.namespaceId GitLab Group ID
 * @returns {string} 校验错误；空字符串表示通过
 */
export function validateScaffoldGitlabConfig({ createRepo, gitlabHost, gitlabToken, namespaceId }) {
  if (!createRepo) return '';

  const host = String(gitlabHost || '').trim();
  const token = String(gitlabToken || '').trim();
  const namespace = String(namespaceId || '').trim();

  if (!host) return 'gitlabHost 不能为空';

  try {
    const url = new URL(host);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return 'gitlabHost 仅支持 http 或 https 地址';
    }
  } catch {
    return 'gitlabHost 格式无效';
  }

  if (!token) return 'gitlabToken 不能为空';
  if (!namespace) return '创建 GitLab 仓库前必须选择 Namespace';
  if (!/^\d+$/.test(namespace) || Number(namespace) <= 0) {
    return 'namespaceId 必须是有效的 GitLab Group ID';
  }

  return '';
}
