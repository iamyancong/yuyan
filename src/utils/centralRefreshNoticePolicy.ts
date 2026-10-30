/** 手动刷新连续失败达到该次数才提示中央异常。 */
export const CENTRAL_NOTICE_MIN_FAILURES = 2;
/** 手动刷新故障持续超过该时长才提示中央异常。 */
export const CENTRAL_NOTICE_MIN_DURATION_MS = 8000;

/** 提示判定输入。 */
export interface CentralRefreshNoticeInput {
  /** 后台或静默刷新：重试期间完全不提示，仅在自动重试最终放弃后提示 */
  quiet: boolean;
  status: 'idle' | 'loading' | 'recovering' | 'failed';
  /** 本轮连续失败次数 */
  failures: number;
  /** 本轮首次失败时间戳（ms），无失败时为 null */
  failingSince: number | null;
  now: number;
}

/**
 * 判断是否展示中央刷新异常提示条。
 * @description 单次慢请求随后重试成功属于正常抖动，不打扰用户；持续故障或最终失败才提示。
 */
export function shouldShowCentralRefreshNotice(input: CentralRefreshNoticeInput): boolean {
  if (input.status === 'failed') return true;
  if (input.status !== 'recovering' || input.quiet) return false;
  if (input.failures >= CENTRAL_NOTICE_MIN_FAILURES) return true;
  return input.failingSince !== null && input.now - input.failingSince >= CENTRAL_NOTICE_MIN_DURATION_MS;
}
