/** 归档选择策略所需的最小站点字段。 */
export interface ArchiveSelectionPolicySite {
  id: string;
  canDownloadFiles: boolean;
}

/** 获取当前下载类型下可选择的站点。 */
export const getSelectableArchiveSites = <T extends ArchiveSelectionPolicySite>(
  sites: T[],
  type: 'all' | 'html' | 'conf'
) => sites.filter((site) => type === 'conf' || site.canDownloadFiles);

/** 清理切换下载类型后已经不可用的选择。 */
export const normalizeArchiveSiteIds = (
  siteIds: string[],
  sites: ArchiveSelectionPolicySite[],
  type: 'all' | 'html' | 'conf'
) => {
  const selectableIds = new Set(getSelectableArchiveSites(sites, type).map((site) => site.id));
  return [...new Set(siteIds)].filter((id) => selectableIds.has(id));
};

/** 判断选择窗口能否提交下载。 */
export const canSubmitArchiveSelection = (siteIds: string[], loading: boolean, downloading: boolean) => {
  return siteIds.length > 0 && !loading && !downloading;
};
