import { useRoute } from 'vue-router';
import type { DeployProjectContext } from '../types';

/**
 * 从路由查询参数中读取项目上下文。
 * @returns 项目上下文
 */
export function useNginxDeployProjectContext(): DeployProjectContext {
  const route = useRoute();
  return {
    projectId: Number(route.query.projectId || 0),
    projectName: String(route.query.projectName || ''),
    projectDescription: String(route.query.projectDescription || ''),
    projectPath: String(route.query.projectPath || ''),
    repositoryUrl: String(route.query.repositoryUrl || ''),
    defaultBranch: String(route.query.defaultBranch || 'dev'),
  };
}
