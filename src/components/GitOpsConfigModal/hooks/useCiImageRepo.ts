/**
 * 用途：解析来源 GitLab 项目的 .gitlab-ci.yml，自动提取镜像仓库地址并暴露为响应式变量。
 * 提供方法 resolveFromProjectPath(fullPath, defaultBranch) 以项目 full_path 拉取 CI 文本并解析出镜像仓库。
 */
import { ref } from 'vue';
import { getProjectByPath, getFileContent } from '@/api/gitlab';

const parseCiImageRepo = (ciText: string): { repo: string } => {
  const pick = (key: string) => {
    const re = new RegExp(`\\b${key}\\s*:\\s*['"]?([^'"]+?)['"]?(\\s|$)`);
    const m = ciText.match(re);
    return (m && (m[1] || '').trim()) || '';
  };
  const REG = pick('HARBOR_REGISTRY') || pick('REGISTRY') || '';
  const PROJ = pick('HARBOR_PROJECT') || pick('PROJECT') || '';
  const NAME = pick('IMAGE_NAME') || pick('IMAGE') || '';
  if (REG && PROJ && NAME) {
    const repo = `${REG.replace(/\/+$/, '')}/${PROJ.replace(/^\/+|\/+$/g, '')}/${NAME.replace(/^\/+|\/+$/g, '')}`;
    return { repo };
  }
  const m = ciText.match(/export\s+IMAGE_REPO=["']?([^"'\n]+)["']?/);
  if (m && m[1]) {
    let repo = m[1];
    if (REG) repo = repo.replace(/\$?HARBOR_REGISTRY/g, REG);
    if (PROJ) repo = repo.replace(/\$?HARBOR_PROJECT/g, PROJ);
    if (NAME) repo = repo.replace(/\$\{?IMAGE_NAME:?[^}]*\}?/g, NAME);
    repo = repo.replace(/\$[A-Z_]+|\$\{[A-Z_:-]+\}/g, '').replace(/:+$/, '');
    return { repo };
  }
  return { repo: '' };
};

export const useCiImageRepo = () => {
  const sourceImageRepo = ref<string>('');

  const resolveFromProjectPath = async (fullPath: string, defaultBranch = 'dev'): Promise<string> => {
    sourceImageRepo.value = '';
    if (!fullPath) return '';
    try {
      const src = await getProjectByPath(fullPath);
      const ci = await getFileContent(src.id, '.gitlab-ci.yml', src.default_branch || defaultBranch);
      const ciText = ci.content || '';
      const { repo } = parseCiImageRepo(ciText);
      sourceImageRepo.value = repo;
      return repo;
    } catch {
      sourceImageRepo.value = '';
      return '';
    }
  };

  return { sourceImageRepo, resolveFromProjectPath };
};
