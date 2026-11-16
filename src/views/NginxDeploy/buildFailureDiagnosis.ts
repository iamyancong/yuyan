/**
 * 构建失败诊断（#58）
 * @description 实现已下沉到 `server/shared/build-failure-diagnosis.mjs`（#43 P2-2），
 * 后端在发布失败时用同一份逻辑产出并持久化 errorSummary，前端打开日志时也用它做精确定位，两边结论一致。
 * 本文件只补前端类型；纯 TS 模块，可被 `node --experimental-strip-types --test` 直接运行。
 */

import type { DeployErrorSummary, DeployLogItem, DeployRecord } from '../../api/deploy';
import * as shared from '../../../server/shared/build-failure-diagnosis.mjs';

/** 诊断选项 */
export interface DiagnoseBuildFailureOptions {
  /** 发布记录：status=failed 时，即使没有识别到失败汇总也给出兜底诊断 */
  record?: Pick<DeployRecord, 'status'> | null;
}

/**
 * 按真实输出诊断构建失败原因。
 * @param logs 发布日志
 * @param options 选项
 * @returns 错误根因诊断；无法判断为失败时返回 null
 */
export function diagnoseBuildFailure(
  logs: DeployLogItem[] = [],
  options: DiagnoseBuildFailureOptions = {}
): DeployErrorSummary | null {
  return shared.diagnoseBuildFailure(logs, options) as DeployErrorSummary | null;
}

/** 把构建工作区内的绝对路径还原为仓库相对路径 */
export const toRepoRelativePath: (rawPath: string) => string = shared.toRepoRelativePath;

/** 从模块说明符提取 npm 包名 */
export const extractPackageName: (specifier: string) => string = shared.extractPackageName;

/** 按 `&&` / `||` / `;` 拆分 shell 命令（引号内不拆） */
export const splitCommandSteps: (command: string) => { steps: string[]; separators: string[] } = shared.splitCommandSteps;
