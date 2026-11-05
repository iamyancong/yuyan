import type { NginxRuntimeStatus } from '@/api/deploy';

export interface NginxVersionDisplay {
  label: string;
  tooltip: string;
  upgradePending: boolean;
}

/**
 * 组装 Nginx 运行时抽屉的版本展示文案。
 */
export function resolveNginxVersionDisplay(
  status:
    | Partial<
        Pick<
          NginxRuntimeStatus,
          'version' | 'runningVersion' | 'diskVersion' | 'upgradePending' | 'versionDetectError'
        >
      >
    | null
    | undefined
): NginxVersionDisplay {
  const running = String(status?.runningVersion || '').trim();
  const disk = String(status?.diskVersion || status?.version || '').trim();
  const detectError = String(status?.versionDetectError || '').trim();
  const upgradePending = Boolean(status?.upgradePending) || Boolean(running && disk && running !== disk);
  if (upgradePending && running && disk) {
    return {
      label: `运行 ${running} · 磁盘 ${disk} · 待平滑升级`,
      tooltip: `运行中的二进制版本为 ${running}，磁盘上的二进制版本为 ${disk}。可执行平滑切换（USR2 + QUIT）。`,
      upgradePending: true,
    };
  }
  const primary = running || disk || String(status?.version || '').trim();
  if (primary) {
    return {
      label: primary,
      tooltip: `当前版本 ${primary}`,
      upgradePending: false,
    };
  }
  return {
    label: '未知',
    tooltip: detectError || '未能探测到 Nginx 版本（无运行进程且无法从校验命令安全提取二进制，或执行 -v 失败）',
    upgradePending: false,
  };
}
