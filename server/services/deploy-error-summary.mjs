/**
 * 发布失败根因落库（#43 P2-2）
 * @description 发布记录以 failed 结束时，用前后端共享的 diagnoseBuildFailure 产出根因，
 * 只保存列表展示与统计需要的精简字段（category / title 等），不存摘录与行号：
 * 日志抽屉打开时前端仍按展示文本重新诊断，保证定位行号与 Monaco 展示一致。
 */
import { diagnoseBuildFailure } from '../shared/build-failure-diagnosis.mjs';

/** 单个字段的最大长度，避免异常长的报错撑大数据库与列表接口 */
const MAX_FIELD_LENGTH = 300;
/** 修改建议可能有多行，单独放宽 */
const MAX_SUGGESTION_LENGTH = 800;
/** 兜底分类（非命令执行失败，如上传 / SSH 阶段） */
const FALLBACK_CATEGORY = '执行失败';

/**
 * 截断文本字段。
 * @param {unknown} value - 原值
 * @param {number} [max] - 最大长度
 * @returns {string} 截断后的文本
 */
function clip(value, max = MAX_FIELD_LENGTH) {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 取最后一条 error 级别日志的首行，作为非构建失败的具体原因。
 * @param {Array<{ level?: string, message?: string }>} logs - 发布日志
 * @returns {string} 原因文本；没有时为空串
 */
function findLastErrorMessage(logs) {
  for (let i = logs.length - 1; i >= 0; i--) {
    const item = logs[i];
    if (item?.level !== 'error') continue;
    const firstLine = String(item.message ?? '').split('\n').map((line) => line.trim()).find(Boolean);
    if (firstLine) return firstLine;
  }
  return '';
}

/**
 * 从失败发布记录的日志生成精简根因。
 * @param {Array<Object>} logs - 发布日志
 * @returns {Object|null} 精简根因；无法诊断时返回 null
 */
export function summarizeFailedRecordLogs(logs) {
  const list = Array.isArray(logs) ? logs : [];
  if (!list.length) return null;
  let summary = null;
  try {
    summary = diagnoseBuildFailure(list, { record: { status: 'failed' } });
  } catch (error) {
    console.warn('[deploy-error-summary] 诊断发布失败原因出错:', error);
    return null;
  }
  if (!summary?.category) return null;
  const result = {
    stage: clip(summary.stage),
    category: clip(summary.category),
    title: clip(summary.title),
  };
  // 上传 / SSH 等非构建失败：通用标题说明不了原因，用最后一条错误日志代替
  if (summary.category === FALLBACK_CATEGORY) {
    const lastError = findLastErrorMessage(list);
    if (lastError) result.title = clip(lastError);
  }
  for (const key of ['violation', 'fileLocation', 'failedStep']) {
    if (summary[key]) result[key] = clip(summary[key]);
  }
  if (summary.suggestion) result.suggestion = clip(summary.suggestion, MAX_SUGGESTION_LENGTH);
  if (summary.exitCode !== undefined && summary.exitCode !== null && summary.exitCode !== '') result.exitCode = summary.exitCode;
  if (summary.otherErrorCount) result.otherErrorCount = Number(summary.otherErrorCount) || 0;
  return result;
}

/**
 * 序列化根因用于落库。
 * @param {Object|null} summary - 精简根因
 * @returns {string|null} JSON 文本
 */
export function serializeErrorSummary(summary) {
  return summary ? JSON.stringify(summary) : null;
}

/**
 * 解析数据库中的根因。
 * @param {string|null|undefined} text - JSON 文本
 * @returns {Object|null} 精简根因
 */
export function parseErrorSummary(text) {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && value.category ? value : null;
  } catch {
    return null;
  }
}
