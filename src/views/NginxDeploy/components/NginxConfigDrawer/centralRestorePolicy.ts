/**
 * Nginx 配置中央备份恢复纯逻辑策略（无 Vue 依赖，便于 node --test 直接运行）。
 */
import type { TargetNginxCentralSnapshot } from '@/api/deploy';

/** 快照来源中文说明 */
const SNAPSHOT_SOURCE_LABELS: Record<string, string> = {
  save: '在线保存',
  sync: '站点同步',
  init: '托管初始化',
  patrol: '每日巡检',
  refresh: '脚本更新',
};

/**
 * 格式化中央快照来源标签。
 * @param source 快照来源
 */
export function formatSnapshotSourceLabel(source: string | undefined | null): string {
  const key = String(source || '').trim();
  return SNAPSHOT_SOURCE_LABELS[key] || key || '未知来源';
}

/**
 * 计算「从中央备份恢复」按钮状态。
 * @param params.snapshot 中央快照响应
 * @param params.remoteExists 线上文件是否存在
 * @param params.remoteSha256 线上文件内容 SHA-256
 * @returns 是否可用与禁用原因
 */
export function resolveCentralRestoreState(params: {
  snapshot: TargetNginxCentralSnapshot | null | undefined;
  remoteExists: boolean;
  remoteSha256: string | undefined | null;
}): { available: boolean; reason: string } {
  const { snapshot, remoteExists, remoteSha256 } = params;
  if (!snapshot || !snapshot.exists) {
    return { available: false, reason: '中央暂无备份' };
  }
  const snapSha = String(snapshot.sha256 || '').trim().toLowerCase();
  const curSha = String(remoteSha256 || '').trim().toLowerCase();
  if (remoteExists && snapSha && curSha && snapSha === curSha) {
    return { available: false, reason: '与线上一致' };
  }
  return { available: true, reason: '' };
}
