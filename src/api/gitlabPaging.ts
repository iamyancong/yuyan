/**
 * GitLab 分页响应头（x-total / x-next-page）解析策略。
 * @description 独立为纯函数以便单测覆盖边界值。
 */

/**
 * 解析 GitLab `x-total` 响应头为安全的分页总数。
 * @description 仅接受非负整数字符串（允许首尾空白）；以下情况一律回退：
 * - 头部缺失（undefined / null）
 * - 空字符串（`Number('')` 为 0，不能误判为总数 0）
 * - 非纯数字内容（'abc'、'3.7'、'-5'、'Infinity'）
 * - 超过 `Number.MAX_SAFE_INTEGER` 的值
 * @param rawTotal 响应头原始值（axios 已统一为小写键，值类型为 string | undefined）
 * @param fallback 头部不可用时的回退总数（通常为本页条目数）
 * @returns 解析后的总数或回退值
 */
export const resolveProjectsTotal = (rawTotal: unknown, fallback: number): number => {
  const text =
    typeof rawTotal === 'string'
      ? rawTotal.trim()
      : typeof rawTotal === 'number'
        ? String(rawTotal)
        : '';
  if (!/^\d+$/.test(text)) return fallback;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : fallback;
};

/** 分页总数估算入参。 */
export interface ResolveProjectsPageTotalParams {
  rawTotal?: unknown;
  rawNextPage?: unknown;
  page?: number;
  perPage?: number;
  itemsOnPage: number;
}

/**
 * 结合 GitLab `x-total` 与 `x-next-page` 响应头解析或估算分页总数。
 * @description
 * 1. 若 x-total 可解析（复用 resolveProjectsTotal 的规则）→ 采用该值；
 * 2. 否则若 x-next-page 存在（非空字符串，或正数）→ 返回 page * perPage + 1（允许至少翻到下一页）；
 *    page / perPage 缺省或非法时采用安全默认（page≥1, perPage≥1）；
 * 3. 否则返回 (page - 1) * perPage + itemsOnPage（最后一页精确）。
 */
export const resolveProjectsPageTotal = (params: ResolveProjectsPageTotalParams): number => {
  const { rawTotal, rawNextPage, page, perPage, itemsOnPage } = params;

  // 1. 若 x-total 可解析（复用 resolveProjectsTotal 规则，非负安全整数）
  const parsedTotal = resolveProjectsTotal(rawTotal, -1);
  if (parsedTotal >= 0) {
    return parsedTotal;
  }

  // 规范化安全默认：page≥1, perPage≥1
  const safePage = typeof page === 'number' && Number.isSafeInteger(page) && page >= 1 ? page : 1;
  const safePerPage = typeof perPage === 'number' && Number.isSafeInteger(perPage) && perPage >= 1 ? perPage : 20;
  const safeItemsOnPage =
    typeof itemsOnPage === 'number' && Number.isSafeInteger(itemsOnPage) && itemsOnPage >= 0 ? itemsOnPage : 0;

  // 2. 检查 x-next-page 是否存在（非空字符串，或正数）
  const hasNextPage =
    (typeof rawNextPage === 'string' && rawNextPage.trim().length > 0) ||
    (typeof rawNextPage === 'number' && Number.isFinite(rawNextPage) && rawNextPage > 0);

  if (hasNextPage) {
    return safePage * safePerPage + 1;
  }

  // 3. 最后一页精确总数
  return (safePage - 1) * safePerPage + safeItemsOnPage;
};
