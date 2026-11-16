/**
 * build-failure-diagnosis.mjs 的类型声明（前端 TS 通过 src/views/NginxDeploy/buildFailureDiagnosis.ts 引用）。
 */

/** 诊断输入的单条日志（与前端 DeployLogItem / 后端发布记录日志结构一致） */
export interface BuildFailureLogItem {
  level?: string;
  message?: string;
  stage?: string;
  source?: string;
  code?: string;
  timestamp?: string;
}

/** 诊断结果（字段与前端 DeployErrorSummary 一致） */
export interface BuildFailureSummary {
  stage?: string;
  category: string;
  title: string;
  violation?: string;
  fileLocation?: string;
  suggestion?: string;
  detail?: string;
  rawDetail?: string;
  lineIndex?: number;
  failedCommand?: string;
  failedStep?: string;
  skippedSteps?: string[];
  exitCode?: number | string;
  otherErrorCount?: number;
  excerpt?: string;
  excerptOmittedLines?: number;
}

/** 诊断选项 */
export interface BuildFailureDiagnoseOptions {
  /** 发布记录：status=failed 时，即使没有识别到失败汇总也给出兜底诊断 */
  record?: { status?: string } | null;
}

export function diagnoseBuildFailure(
  logs?: readonly BuildFailureLogItem[],
  options?: BuildFailureDiagnoseOptions
): BuildFailureSummary | null;
export function toRepoRelativePath(rawPath: string): string;
export function extractPackageName(specifier: string): string;
export function splitCommandSteps(command: string): { steps: string[]; separators: string[] };
