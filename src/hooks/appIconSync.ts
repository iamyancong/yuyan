import { isTauri } from '../utils/env.ts';

/** Tauri invoke 函数签名（仅取本模块需要的部分） */
type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** 应用图标同步依赖，便于单测注入 */
export interface AppIconSyncDeps {
  /** 是否运行在 Tauri 桌面端 */
  isTauri?: () => boolean;
  /** 加载 Tauri invoke */
  loadInvoke?: () => Promise<TauriInvoke>;
}

const defaultLoadInvoke = async (): Promise<TauriInvoke> => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke as TauriInvoke;
};

/**
 * 动态同步应用图标（暗夜霓虹玻璃 / 晨曦微光白玉）。
 * @description 仅桌面端生效；网页端没有 Tauri 运行时，直接跳过，避免每次切换主题都在控制台报 invoke 错误。
 * @param isDark 是否为暗黑模式
 * @param deps 可选依赖注入
 * @returns 是否发起了同步
 */
export function syncAppIcon(isDark: boolean, deps: AppIconSyncDeps = {}): boolean {
  const inTauri = deps.isTauri ?? isTauri;
  if (!inTauri()) return false;
  const loadInvoke = deps.loadInvoke ?? defaultLoadInvoke;
  loadInvoke()
    .then((invoke) => invoke('change_app_icon', { isDark }))
    .catch((err) => {
      console.error('Failed to change app icon via Tauri:', err);
    });
  return true;
}
