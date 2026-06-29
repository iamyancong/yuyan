/**
 * 用途：根据应用英文名与自定义目录名推导 GitOps 目录与 K8s 资源命名。
 * 输出包含：appSlug、目录前缀、基础名称 buildK8sBaseId、带后缀名称构造器等工具与清洗函数。
 */
import { computed, type ComputedRef, type Ref } from 'vue';

const toKebabCase = (v: string): string =>
  (v || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();

const shortHash = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash >>> 0) * 0x01000193;
  }
  return Math.abs(hash >>> 0)
    .toString(36)
    .slice(0, 6);
};

const DICT_ABBR: Record<string, string> = {
  frontend: 'fe',
  backend: 'be',
  datamiddle: 'dm',
  operations: 'ops',
  operation: 'ops',
  monitoring: 'mon',
  dashboard: 'dash',
  management: 'mgmt',
  service: 'svc',
  services: 'svcs',
  application: 'app',
  platform: 'plat',
  middleware: 'mw',
};

const abbreviateToken = (token: string): string => {
  const lower = token.toLowerCase();
  if (DICT_ABBR[lower]) return DICT_ABBR[lower];
  if (lower.length <= 6) return lower;
  const core = lower[0] + lower.slice(1).replace(/[aeiou]/g, '');
  return core.slice(0, Math.min(5, core.length));
};

const buildDirName = (slug: string): string => {
  const basePrefix = 'yss-datamiddle-frontend';
  const cleanSlug = (slug || '')
    .replace(/^datamiddle-/, '')
    .replace(/^frontend-/, '')
    .replace(/-+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '');
  if (!cleanSlug) return basePrefix;
  let candidate = `${basePrefix}-${cleanSlug}`;
  if (candidate.length <= 63) return candidate;
  const parts = cleanSlug.split('-').filter(Boolean);
  const abbr = parts.map(abbreviateToken).join('-');
  candidate = `${basePrefix}-${abbr}`;
  if (candidate.length <= 63) return candidate;
  const shrinkStep = (tokens: string[], minLen = 1) => {
    return tokens.map((t, idx) => {
      if (idx === 0) return t.slice(0, Math.max(3, Math.min(12, t.length)));
      if (idx === 1) return t.slice(0, Math.max(2, Math.min(8, t.length)));
      if (idx === 2) return t.slice(0, Math.max(2, Math.min(6, t.length)));
      return t.slice(0, Math.max(minLen, Math.min(4, t.length)));
    });
  };
  let tokens = abbr.split('-').filter(Boolean);
  for (let min = 2; min >= 1; min--) {
    tokens = shrinkStep(tokens, min);
    candidate = `${basePrefix}-${tokens.join('-')}`;
    if (candidate.length <= 63) return candidate;
  }
  const initials = tokens.map((t) => t[0]).join('');
  const hash = shortHash(cleanSlug);
  candidate = `${basePrefix}-${initials}-${hash}`;
  if (candidate.length <= 63) return candidate;
  const budget = 63 - (basePrefix.length + 1 + hash.length + 1);
  const clipped = initials.slice(0, Math.max(4, budget));
  return `${basePrefix}-${clipped}-${hash}`;
};

export type UseGitOpsNamingResult = {
  appNameRaw: ComputedRef<string>;
  appSlugHyphen: ComputedRef<string>;
  frontendDirName: ComputedRef<string>;
  effectiveDirName: ComputedRef<string>;
  targetDirPrefix: ComputedRef<string>;
  buildK8sBaseId: ComputedRef<string>;
  buildK8sNameWithSuffix: (suffix: string) => string;
  setDefaultCustomDirName: () => void;
  sanitizeCustomDirName: (v: string) => string;
};

export const useGitOpsNaming = (appName: Ref<string>, customDirName: Ref<string>): UseGitOpsNamingResult => {
  const appNameRaw = computed(() => {
    const raw = (appName.value || '').trim();
    return raw
      .replace(/^yss-datamiddle-frontend-/, '')
      .replace(/^yss-datamiddle-/, '')
      .replace(/^data-middle-/, '')
      .replace(/^datamiddle-/, '');
  });

  const appSlugHyphen = computed(() => toKebabCase(appNameRaw.value || ''));

  const frontendDirName = computed(() => (appSlugHyphen.value ? buildDirName(appSlugHyphen.value) : 'yss-datamiddle-frontend'));

  const sanitizeCustomDirName = (v: string): string => {
    const cleaned = toKebabCase(v || '')
      .replace(/^-+|-+$/g, '')
      .replace(/[^a-z0-9-]/g, '');
    return cleaned.length > 63 ? cleaned.slice(0, 63) : cleaned;
  };

  const effectiveDirName = computed(() => {
    const v = (customDirName.value && customDirName.value.trim()) || '';
    if (!v) return frontendDirName.value;
    return sanitizeCustomDirName(v);
  });

  const targetDirPrefix = computed(() => (effectiveDirName.value ? `${effectiveDirName.value}/.deployments` : ''));

  const buildK8sBaseId = computed(() => {
    const v = effectiveDirName.value || frontendDirName.value || '';
    return v.length <= 63 ? v : v.slice(0, 63);
  });

  const buildK8sNameWithSuffix = (suffix: string): string => {
    const base = buildK8sBaseId.value;
    const suff = (suffix || '').replace(/^-+/, '');
    const need = base.length + 1 + suff.length;
    if (need <= 63) return `${base}-${suff}`;
    const prefix = 'yss-datamiddle-frontend';
    const ensureHyphen = base.startsWith(`${prefix}-`) ? base : `${prefix}-${base}`;
    const after = ensureHyphen.slice(prefix.length + 1);
    const tokens = after.split('-').filter(Boolean);
    const shrink = (arr: string[], minLen = 1) =>
      arr.map((t, idx) => {
        if (idx === 0) return t.slice(0, Math.max(3, Math.min(12, t.length)));
        if (idx === 1) return t.slice(0, Math.max(2, Math.min(8, t.length)));
        if (idx === 2) return t.slice(0, Math.max(2, Math.min(6, t.length)));
        return t.slice(0, Math.max(minLen, Math.min(4, t.length)));
      });
    let cur = tokens.slice();
    for (let min = 2; min >= 1; min--) {
      cur = shrink(cur, min);
      const attempt = `${prefix}-${cur.join('-')}-${suff}`;
      if (attempt.length <= 63) return attempt;
    }
    const initials = cur.map((t) => t[0]).join('');
    const hash = shortHash(after);
    const maxMid = 63 - (prefix.length + 1 + 1 + suff.length + 1 + hash.length);
    const mid = (initials || 'x').slice(0, Math.max(1, maxMid));
    return `${prefix}-${mid}-${hash}-${suff}`;
  };

  const setDefaultCustomDirName = () => {
    customDirName.value = frontendDirName.value;
  };

  return {
    appNameRaw,
    appSlugHyphen,
    frontendDirName,
    effectiveDirName,
    targetDirPrefix,
    buildK8sBaseId,
    buildK8sNameWithSuffix,
    setDefaultCustomDirName,
    sanitizeCustomDirName,
  };
};
