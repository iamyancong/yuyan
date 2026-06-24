/**
 * 用途：模板路径映射与占位变量替换。
 * - computeTargetPath：把模板根路径替换为目标目录前缀
 * - applyReplacements：替换 YAML 中的服务名、别名与镜像仓库地址等
 */
import type { ComputedRef } from 'vue';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export type NamingContext = {
  buildK8sBaseId: ComputedRef<string>;
  buildK8sNameWithSuffix: (suffix: string) => string;
};

export const useTemplateReplace = (ctx: NamingContext) => {
  const computeTargetPath = (templatePath: string, templateRoot: string, targetDirPrefix: string): string => {
    if (!templateRoot) return templatePath;
    const re = new RegExp('^' + escapeRegExp(templateRoot));
    return templatePath.replace(re, targetDirPrefix);
  };

  const applyReplacements = (content: string, opts: { appSlugHyphen: string; alias: string; imageRepo?: string }): string => {
    if (!content) return content;
    let out = content;
    // 增强正则：匹配可选的 -v3, -v4 等版本号后缀，防止替换时叠加 (比如 data-quality-v3 -> quality-v3-v3)
    const vSuffix = '(-v\\d+)?';

    out = out.replace(
      new RegExp('\\b' + escapeRegExp('yss-datamiddle-frontend-data-quality-deploy') + vSuffix + '\\b', 'g'),
      ctx.buildK8sNameWithSuffix('deploy')
    );
    out = out.replace(
      new RegExp('\\b' + escapeRegExp('yss-datamiddle-frontend-data-quality-service') + vSuffix + '\\b', 'g'),
      ctx.buildK8sNameWithSuffix('service')
    );
    out = out.replace(
      new RegExp('\\b' + escapeRegExp('yss-datamiddle-frontend-data-quality-svc') + vSuffix + '\\b', 'g'),
      ctx.buildK8sNameWithSuffix('svc')
    );
    if (ctx.buildK8sBaseId.value) {
      out = out.replace(new RegExp('\\b' + escapeRegExp('yss-datamiddle-frontend-data-quality') + vSuffix + '\\b', 'g'), ctx.buildK8sBaseId.value);
    }
    if (opts.appSlugHyphen) {
      // data-quality 也可能后面跟着 -v3
      out = out.replace(new RegExp(escapeRegExp('data-quality') + vSuffix, 'g'), opts.appSlugHyphen);
    }
    if (opts.alias) {
      const ensureYamlString = (v: string) =>
        `${v
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/[\r\n]+/g, ' ')}`;
      const aliasYaml = ensureYamlString(opts.alias);
      out = out.replace(
        /(^|\n)([ \t]*)kubesphere\.io\/alias-name\s*:\s*.*/g,
        (_m, pre, indent) => `${pre}${indent}kubesphere.io/alias-name: ${aliasYaml}`
      );
    }
    if (opts.imageRepo) {
      out = out.replace(/(^|\n)([ \t]*image\s*:\s*)([^\s#]+)(.*)/g, (_m, pre, indent, val, tail) => {
        const current = String(val || '');
        let tag = '';
        const lastColon = current.lastIndexOf(':');
        if (lastColon > current.indexOf('/')) {
          tag = current.slice(lastColon);
        }
        return `${pre}${indent}${opts.imageRepo}${tag || ''}${tail || ''}`;
      });
    }
    return out;
  };

  return { computeTargetPath, applyReplacements };
};
