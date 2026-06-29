import { inject, provide, type InjectionKey, type Ref } from 'vue';
import type { DeployProjectContext, RefreshActiveTabOptions } from '../types';
import type { DeployServer, DeployTarget, DeployProgressSnapshot, DeployRecord } from '@/api/deploy';

/**
 * Nginx 部署模块全局上下文状态接口
 * @description 用于 Provide / Inject 依赖注入，打破 Hooks 之间层层传参、交叉耦合的链路。
 */
export interface NginxDeployContext {
  /** 当前选中的路由/项目上下文 */
  project: DeployProjectContext;

  // --- 鉴权相关状态与方法 ---
  /** 鉴权状态（例如后端返回的 token/用户对象） */
  authState: any;
  /** 当前登录用户名 */
  userName: Ref<string>;
  /** 是否已成功登录 */
  isLoggedIn: Ref<boolean>;
  /** 鉴权检查是否已就绪 */
  isAuthReady: () => boolean;
  /** 校验并确保登录，未登录时自动唤起登录弹窗 */
  ensureLoggedIn: () => boolean;
  /** 手动打开登录弹窗 */
  openLoginModal: () => void;
  /** 初始化登录态检查 */
  initAuthCheck: () => Promise<boolean>;

  // --- 核心实体列表数据（只读/共享响应式） ---
  /** 服务器缓存列表 */
  servers: Ref<DeployServer[]>;
  /** 当前过滤条件下的部署目标列表 */
  targets: Ref<DeployTarget[]>;
  /** 所有的部署目标列表（未经过滤，用于下拉框过滤源） */
  allTargets: Ref<DeployTarget[]>;
  /** 当前处于活动查看状态 of 部署记录 */
  activeRecord: Ref<DeployRecord | null>;
  /** 是否具备项目上下文筛选 */
  hasProjectContext: Ref<boolean>;
  /** 目标表单加载状态 */
  targetFormLoading: Ref<boolean>;
  /** 当前选中的部署目标 ID */
  activeTargetId: Ref<number | null>;

  // --- 刷新与生命周期方法 ---
  /** 刷新当前激活 Tab 页面的数据 */
  refreshActiveTab: (options?: RefreshActiveTabOptions) => Promise<void>;
  /** 刷新服务器列表 */
  refreshServerList: () => Promise<void>;
  /** 刷新部署目标列表 */
  refreshTargetList: () => Promise<void>;
  /** 刷新发布记录列表 */
  refreshRecordList: () => Promise<void>;
  /** 重置发布历史列表的分页参数 */
  resetRecordPage: () => void;

  // --- 运行态快照与轮询状态 ---
  /** 部署目标的实时运行态快照缓存字典 */
  targetRuntimeSnapshots: Ref<Record<number, DeployProgressSnapshot>>;
  /** 写入某个部署目标的实时运行态快照 */
  setTargetRuntimeSnapshot: (snapshot: DeployProgressSnapshot) => void;
  /** 清除某个部署目标的实时运行态快照 */
  clearTargetRuntimeSnapshot: (targetId: number) => void;
}

/** 注入令牌 Key */
export const NginxDeployContextKey: InjectionKey<NginxDeployContext> = Symbol('NginxDeployContextKey');

/**
 * 注入 Nginx 部署上下文状态
 * @returns 共享的 Nginx 部署上下文对象
 * @throws 当未在提供者组件内调用时抛出异常
 */
export function useNginxDeployContext(): NginxDeployContext {
  const context = inject(NginxDeployContextKey);
  if (!context) {
    throw new Error('[yuyan-ops] useNginxDeployContext 必须在 provideNginxDeployContext 的子组件中调用');
  }
  return context;
}

/**
 * 提供 Nginx 部署上下文状态
 * @param context 上下文实现对象
 */
export function provideNginxDeployContext(context: NginxDeployContext): void {
  provide(NginxDeployContextKey, context);
}
