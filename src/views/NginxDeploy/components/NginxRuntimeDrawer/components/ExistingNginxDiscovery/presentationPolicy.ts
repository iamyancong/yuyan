import type {
  NginxDiscoveryAccessEndpoint,
  NginxDiscoveryRoot,
  NginxDiscoveryRuntime,
  NginxDiscoverySite,
} from '@/api/deploy';

/** 展示层站点候选。 */
export interface NginxDiscoveryCandidate {
  key: string;
  runtime: NginxDiscoveryRuntime;
  site: NginxDiscoverySite;
  root: NginxDiscoveryRoot;
  endpoint: NginxDiscoveryAccessEndpoint | null;
  highConfidence: boolean;
}

/** 发现结果的三类展示分组。 */
export interface NginxDiscoveryGroups {
  selectableRuntimes: NginxDiscoveryRuntime[];
  connectedRuntimes: NginxDiscoveryRuntime[];
  diagnosticRuntimes: NginxDiscoveryRuntime[];
  candidates: NginxDiscoveryCandidate[];
  recommendedKey: string;
}

/**
 * 生成候选稳定键。
 * @param runtimeId 运行实例 ID
 * @param siteId 站点 ID
 * @param rootPath 前端根目录
 * @returns 候选稳定键
 */
export const createDiscoveryCandidateKey = (runtimeId: string, siteId: string, rootPath: string) => (
  `${runtimeId}:${siteId}:${rootPath}`
);

/**
 * 判断候选是否满足唯一推荐的全部强条件。
 * @param runtime Nginx 运行实例
 * @param site server 站点
 * @param root 静态根目录
 * @returns 是否为高置信度候选
 */
export const isHighConfidenceDiscoveryCandidate = (
  runtime: NginxDiscoveryRuntime,
  site: NginxDiscoverySite,
  root: NginxDiscoveryRoot,
) => runtime.running
  && runtime.inspectionState === 'ready'
  && !runtime.connectedInstanceId
  && root.path.startsWith('/')
  && root.exists
  && root.readable
  && root.hasIndexHtml
  && site.listens.some((listen) => listen.transport === 'tcp' && Boolean(listen.port) && !listen.loopback)
  && site.accessEndpoints.some((endpoint) => endpoint.scope === 'remote');

/**
 * 将运行实例展开为“运行时 + 站点 + root”候选。
 * @param runtime Nginx 运行实例
 * @returns 可选择候选
 */
export const createRuntimeDiscoveryCandidates = (runtime: NginxDiscoveryRuntime): NginxDiscoveryCandidate[] => (
  runtime.sites.flatMap((site) => site.roots.map((root) => ({
    key: createDiscoveryCandidateKey(runtime.id, site.id, root.path),
    runtime,
    site,
    root,
    endpoint: site.accessEndpoints.find((item) => item.scope === 'remote') || site.accessEndpoints[0] || null,
    highConfidence: isHighConfidenceDiscoveryCandidate(runtime, site, root),
  })))
);

/**
 * 判断新快照是否仍包含用户已采用的候选。
 * @param runtimes 新扫描快照
 * @param selectedKey 已采用候选键
 * @returns 是否应保留采用状态
 */
export const hasDiscoveryCandidateKey = (runtimes: NginxDiscoveryRuntime[], selectedKey: string) => (
  Boolean(selectedKey) && runtimes.some((runtime) => createRuntimeDiscoveryCandidates(runtime).some((candidate) => candidate.key === selectedKey))
);

/**
 * 将扫描运行实例分为可接入、已接入和需处理三组。
 * @param runtimes 扫描运行实例
 * @returns 分组、候选和唯一推荐键
 */
export const groupNginxDiscoveryRuntimes = (runtimes: NginxDiscoveryRuntime[]): NginxDiscoveryGroups => {
  const connectedRuntimes = runtimes.filter((runtime) => Boolean(runtime.connectedInstanceId));
  const candidates = runtimes
    .filter((runtime) => !runtime.connectedInstanceId && runtime.binaryResolution === 'resolved' && runtime.inspectionState !== 'unavailable')
    .flatMap(createRuntimeDiscoveryCandidates);
  const selectableIds = new Set(candidates.map((candidate) => candidate.runtime.id));
  const selectableRuntimes = runtimes.filter((runtime) => selectableIds.has(runtime.id));
  const diagnosticRuntimes = runtimes.filter((runtime) => !runtime.connectedInstanceId && !selectableIds.has(runtime.id));
  const highConfidence = candidates.filter((candidate) => candidate.highConfidence);
  return {
    selectableRuntimes,
    connectedRuntimes,
    diagnosticRuntimes,
    candidates,
    recommendedKey: highConfidence.length === 1 ? highConfidence[0]?.key || '' : '',
  };
};

/**
 * 格式化 server_name，避免把占位值冒充地址。
 * @param site Nginx server 站点
 * @returns 原始配置摘要
 */
export const formatDiscoveryServerNames = (site: NginxDiscoverySite) => {
  const names = site.serverNames.filter((name) => name && name !== '_' && !name.includes('$') && !name.includes('_') && !/[~*]/.test(name));
  return names.length ? names.join('、') : '未配置/默认站点';
};
