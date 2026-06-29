/**
 * GitOps 表单核心业务逻辑
 */
import { ref, computed, type Ref } from 'vue';
import message from 'ant-design-vue/es/message';
import { openExternal } from '@/utils/open';
import type { FileItem, OperationMode } from '../constant';
import { YAML_FILE_NAME, generateBranchName as genBranchName } from '../constant';
import {
  getProjectByPath,
  getBranches,
  getRepoTree,
  getFileContent,
  createCommit,
  createBranch,
  createMergeRequest,
  type CommitAction,
} from '@/api/gitlab';
import { findSimilarDirectories, SIMILARITY_CONFIG, type SimilarDirectory } from './useDirectoryMatcher';

/**
 * GitOps 表单状态管理
 */
export const useGitOpsForm = (params: {
  /** GitOps 仓库路径 */
  gitopsProjectPath: Ref<string>;
  /** 默认分支 */
  defaultBranch: Ref<string>;
  /** 源项目路径(用于解析镜像) */
  sourceProjectPath: Ref<string>;
  /** 模板目录 */
  templateDirResolved: Ref<string>;
  /** 前端目录名(用于智能匹配) */
  frontendDirName: Ref<string>;
  /** 目标目录前缀 */
  targetDirPrefix: Ref<string>;
  /** 应用 slug */
  appSlugHyphen: Ref<string>;
  /** 别名(优先级: 中文名 > 描述 > 英文名) */
  aliasPreferred: Ref<string>;
  /** 镜像仓库(来自 CI) */
  sourceImageRepo: Ref<string>;
  /** 自定义目录名 */
  customDirName: Ref<string>;
  /** 计算目标路径函数 */
  computeTargetPath: (originalPath: string, templateDir: string, targetPrefix: string) => string;
  /** 应用替换函数 */
  applyReplacements: (content: string, vars: { appSlugHyphen: string; alias: string; imageRepo: string }) => string;
  /** 从项目路径解析镜像函数 */
  resolveFromProjectPath: (projectPath: string, branch: string) => Promise<void>;
  /** 清洗自定义目录名函数 */
  sanitizeCustomDirName: (dir: string) => string;
}) => {
  const loading = ref(false);
  const ready = ref(false);
  const projectId = ref<number | null>(null);
  const branches = ref<string[]>([]);
  const selectedBranch = ref<string>('');
  const dirOptions = ref<string[]>([]);
  const loadError = ref<string>('');
  const suggestedDir = ref<SimilarDirectory | null>(null);
  const autoMatchPerformed = ref(false);

  const files = ref<FileItem[]>([]);
  const activeIndex = ref(0);
  const mode = ref<OperationMode>('create');

  const useMergeRequest = ref(true);
  const newBranchName = ref<string>('');
  const mrTitle = ref<string>('');
  const mrDescription = ref<string>('');

  let inflightLoadAll: Promise<void> | null = null;

  /**
   * 加载所有数据
   */
  const loadAll = async (): Promise<void> => {
    if (inflightLoadAll) return inflightLoadAll;
    if (loading.value) return Promise.resolve();
    loading.value = true;
    ready.value = false;
    loadError.value = '';

    inflightLoadAll = (async () => {
      try {
        // 1. 定位 GitOps 仓库
        const proj = await getProjectByPath(params.gitopsProjectPath.value);
        projectId.value = proj.id;

        // 2. 分支
        const bs = await getBranches(proj.id);
        branches.value = bs.map((b: any) => b.name);

        if (!selectedBranch.value || !branches.value.includes(selectedBranch.value)) {
          const devExists = branches.value.includes(params.defaultBranch.value);
          if (devExists) {
            selectedBranch.value = params.defaultBranch.value;
          } else {
            const defaultBranch = (bs as any[]).find((b) => (b as any).default === true)?.name;
            selectedBranch.value = defaultBranch || branches.value[0] || '';
          }
        }

        // 2.1 解析来源项目 .gitlab-ci.yml，提取镜像仓库
        try {
          await params.resolveFromProjectPath(params.sourceProjectPath.value, params.defaultBranch.value);
        } catch {}

        // 目录下拉：读取分支根目录下的全部一级目录
        try {
          const dirs: string[] = [];
          const perPage = 100;
          let page = 1;
          while (true) {
            const chunk = await getRepoTree(proj.id, '', selectedBranch.value, false, page, perPage);
            if (!chunk || chunk.length === 0) break;
            dirs.push(...chunk.filter((t: any) => t.type === 'tree').map((t: any) => t.name as string));
            if (chunk.length < perPage) break;
            page += 1;
          }
          dirOptions.value = Array.from(new Set(dirs));

          // 智能目录匹配
          const existsInDirOptions = dirOptions.value.includes(params.frontendDirName.value);
          if (!existsInDirOptions && dirOptions.value.length > 0 && !autoMatchPerformed.value) {
            autoMatchPerformed.value = true;
            const similarDirs = findSimilarDirectories(
              params.frontendDirName.value,
              dirOptions.value,
              SIMILARITY_CONFIG.AUTO_FILL_THRESHOLD,
              SIMILARITY_CONFIG.MAX_SUGGESTIONS
            );

            if (similarDirs.length > 0) {
              const bestMatch = similarDirs[0];
              params.customDirName.value = bestMatch.dir;
              suggestedDir.value = bestMatch;
              console.log(`检测到相似目录: ${bestMatch.dir}, 相似度: ${(bestMatch.similarity * 100).toFixed(0)}%`);
            }
          }
        } catch {}

        // 3. 读取模板树与内容
        let tree;
        let actualTemplateDir = params.templateDirResolved.value;

        try {
          tree = await getRepoTree(proj.id, params.templateDirResolved.value, selectedBranch.value, true);
        } catch (e: any) {
          const errMsg = e?.response?.data?.message || e?.message || '';
          const is404 = /404|not found|does not exist/i.test(String(errMsg));

          if (is404 && params.customDirName.value && actualTemplateDir.includes(params.customDirName.value)) {
            const fallbackTemplateDir = 'yss-datamiddle-frontend-data-quality/.deployments';
            try {
              tree = await getRepoTree(proj.id, fallbackTemplateDir, selectedBranch.value, true);
              actualTemplateDir = fallbackTemplateDir;
            } catch (fallbackError: any) {
              loadError.value = `模板目录 "${fallbackTemplateDir}" 在分支 "${selectedBranch.value}" 中也不存在`;
              files.value = [];
              return;
            }
          } else {
            if (is404) {
              loadError.value = `模板目录 "${params.templateDirResolved.value}" 在分支 "${selectedBranch.value}" 中不存在`;
            } else {
              loadError.value = `加载模板目录失败: ${errMsg}`;
            }
            files.value = [];
            return;
          }
        }

        const blobs = tree.filter((t) => t.type === 'blob');

        // 如果当前分支的模板为空，尝试从 dev 分支加载
        let fallbackBranch = null;
        if (blobs.length === 0 && selectedBranch.value !== 'dev') {
          try {
            const devTree = await getRepoTree(proj.id, actualTemplateDir, 'dev', true);
            const devBlobs = devTree.filter((t) => t.type === 'blob');

            if (devBlobs.length > 0) {
              tree = devTree;
              blobs.length = 0;
              blobs.push(...devBlobs);
              fallbackBranch = 'dev';
            }
          } catch (e) {}
        }

        const contents = await Promise.all(
          blobs.map(async (b) => {
            const f = await getFileContent(proj.id, b.path, fallbackBranch || selectedBranch.value);
            return { path: b.path, content: f.content };
          })
        );

        const prepared: FileItem[] = contents.map(({ path, content }) => {
          const targetPath = params.computeTargetPath(path, actualTemplateDir, params.targetDirPrefix.value);
          const edited = params.applyReplacements(content, {
            appSlugHyphen: params.appSlugHyphen.value,
            alias: params.aliasPreferred.value,
            imageRepo: params.sourceImageRepo.value,
          });
          return { originalPath: path, targetPath, templateContent: content, editedContent: edited };
        });

        // 4. 检测目标目录是否存在
        let existingPaths = new Set<string>();
        try {
          const targetTree = params.targetDirPrefix.value ? await getRepoTree(proj.id, params.targetDirPrefix.value, selectedBranch.value, true) : [];
          const targetBlobs = targetTree.filter((t) => t.type === 'blob');
          existingPaths = new Set(targetBlobs.map((t) => t.path));
          mode.value = targetBlobs.length > 0 ? 'update' : 'create';
        } catch {
          mode.value = 'create';
        }

        // 5. 更新模式：补充现有文件内容，方便 Diff
        if (mode.value === 'update' && existingPaths.size) {
          for (const item of prepared) {
            if (existingPaths.has(item.targetPath)) {
              try {
                const f = await getFileContent(proj.id, item.targetPath, selectedBranch.value);
                item.existingContent = f.content;
              } catch {}
            } else {
              item.existingContent = '';
            }
          }
        }

        files.value = prepared;
        const prefer = prepared.findIndex((f) => f.targetPath.endsWith(`/${YAML_FILE_NAME}`));
        activeIndex.value = prefer !== -1 ? prefer : 0;

        // 默认分支名与 MR 标题
        if (!newBranchName.value) newBranchName.value = genBranchName(params.appSlugHyphen.value);
        mrTitle.value = `${mode.value === 'create' ? 'feat' : 'chore'}(gitops): ${mode.value} ${params.targetDirPrefix.value}`;
        mrDescription.value = `This MR is generated by yuyan-ops for ${params.targetDirPrefix.value}.`;
      } catch (e: any) {
        const errMsg = e?.message || '加载 GitOps 模板失败';
        loadError.value = errMsg;
        message.error(errMsg);
      } finally {
        loading.value = false;
        ready.value = true;
      }
    })();

    try {
      await inflightLoadAll;
    } finally {
      inflightLoadAll = null;
    }
  };

  /**
   * 提交表单
   */
  const handleSubmit = async (onSuccess: () => void) => {
    if (!projectId.value || !selectedBranch.value) return;
    if (!params.targetDirPrefix.value) {
      message.warning('缺少目标目录，无法提交');
      return;
    }

    const actions: CommitAction[] = [];

    // 再次探测现有文件，决定 create/update
    let existing = new Set<string>();
    try {
      const targetTree = await getRepoTree(projectId.value, params.targetDirPrefix.value, selectedBranch.value, true);
      existing = new Set(targetTree.filter((t) => t.type === 'blob').map((t) => t.path));
    } catch {}

    for (const f of files.value) {
      const shouldUpdate = existing.has(f.targetPath);
      actions.push({ action: shouldUpdate ? 'update' : 'create', file_path: f.targetPath, content: f.editedContent });
    }

    loading.value = true;
    try {
      const msg = `${mode.value === 'create' ? 'feat' : 'chore'}(gitops): ${mode.value} ${params.targetDirPrefix.value}`;

      if (useMergeRequest.value) {
        const sourceBranch = (newBranchName.value || '').trim();
        if (!sourceBranch) {
          message.warning('请填写新分支名称');
          return;
        }

        // 1. 创建分支
        try {
          await createBranch(projectId.value, sourceBranch, selectedBranch.value);
        } catch (e: any) {
          const msg = e?.response?.data?.message || e?.message || '';
          if (!/already exists/i.test(String(msg))) {
            throw e;
          }
        }

        // 2. 提交到新分支
        await createCommit(projectId.value, sourceBranch, msg, actions);

        // 3. 创建 MR
        const mr = await createMergeRequest(projectId.value, {
          source_branch: sourceBranch,
          target_branch: selectedBranch.value,
          title: (mrTitle.value || msg).trim(),
          description: (mrDescription.value || '').trim(),
          remove_source_branch: true,
          allow_collaboration: true,
          squash: false,
        });

        message.success(`MR 已创建：${mr.web_url}`);
        try {
          await openExternal(mr.web_url);
        } catch {}
        onSuccess();
      } else {
        // 直推
        await createCommit(projectId.value, selectedBranch.value, msg, actions);
        message.success('GitOps 配置已推送');
        onSuccess();
      }
    } catch (e: any) {
      message.error(e?.response?.data?.message || e?.message || '提交失败');
    } finally {
      loading.value = false;
    }
  };

  /**
   * 下载 YAML 文件
   */
  const downloadYaml = () => {
    const item = files.value.find((f) => f.targetPath.endsWith(`/${YAML_FILE_NAME}`) || f.originalPath.endsWith(`/${YAML_FILE_NAME}`));
    if (!item) {
      message.warning(`未找到 ${YAML_FILE_NAME}`);
      return;
    }
    const content = item.editedContent || '';
    try {
      const blob = new Blob([content], { type: 'application/x-yaml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = YAML_FILE_NAME;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      message.error(e?.message || '下载失败');
    }
  };

  /**
   * 是否可下载 YAML
   */
  const canDownload = computed(() => {
    const item = files.value.find((f) => f.targetPath.endsWith(`/${YAML_FILE_NAME}`) || f.originalPath.endsWith(`/${YAML_FILE_NAME}`));
    return !!item && !!item.editedContent;
  });

  /**
   * 重置表单状态
   */
  const reset = () => {
    files.value = [];
    selectedBranch.value = '';
    activeIndex.value = 0;
    mode.value = 'create';
    newBranchName.value = '';
    mrTitle.value = '';
    mrDescription.value = '';
    ready.value = false;
    params.sourceImageRepo.value = '';
    loadError.value = '';
    suggestedDir.value = null;
    autoMatchPerformed.value = false;
  };

  return {
    loading,
    ready,
    projectId,
    branches,
    selectedBranch,
    dirOptions,
    loadError,
    suggestedDir,
    files,
    activeIndex,
    mode,
    useMergeRequest,
    newBranchName,
    mrTitle,
    mrDescription,
    canDownload,
    loadAll,
    handleSubmit,
    downloadYaml,
    reset,
  };
};
