import type { DeployRecord } from '@/api/deploy';
import { getGitLabHost } from '@/api/gitlab';

/** 表格默认高度 */
export const TABLE_DEFAULT_HEIGHT = 420;

/** 表格最小高度 */
export const TABLE_MIN_HEIGHT = 240;

/** 表格行高配置 */
export const TABLE_CELL_CONFIG = { height: 58 };

/** 表头高度 */
export const TABLE_HEADER_HEIGHT = 42;

/**
 * 构建 GitLab 提交记录页面链接。
 * @param record 发布记录
 * @returns 提交记录页面链接，无法获取时返回空字符串
 */
export const buildCommitUrl = (record: DeployRecord): string => {
  const commitSha = record.commitSha;
  if (!commitSha) return '';

  const gitlabHost = getGitLabHost();
  const host = gitlabHost.replace(/\/+$/, '').replace(/\/api\/v4$/, '');
  const projectPath = record.projectPath || '';

  if (projectPath) {
    return `${host}/${projectPath}/-/commit/${commitSha}`;
  }

  const repoUrl = record.repositoryUrl || '';
  if (repoUrl) {
    if (repoUrl.startsWith('http://') || repoUrl.startsWith('https://')) {
      const baseUrl = repoUrl.replace(/\.git$/i, '');
      return `${baseUrl}/-/commit/${commitSha}`;
    }
    if (repoUrl.includes('@')) {
      const match = repoUrl.match(/@([^:/]+)(?::\d+)?[:/](.+)$/i);
      if (match) {
        const hostName = match[1];
        const repoPath = match[2].replace(/\.git$/i, '');
        let portPart = '';
        try {
          const urlObj = new URL(host);
          if (urlObj.port) portPart = `:${urlObj.port}`;
        } catch {}
        return `${host.startsWith('https') ? 'https' : 'http'}://${hostName}${portPart}/${repoPath}/-/commit/${commitSha}`;
      }
    }
  }

  return '';
};
