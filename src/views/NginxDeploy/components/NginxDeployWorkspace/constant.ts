import type { YTableActionConfig } from '@yss-ui/components/lite';
import type { DeployProjectContext } from '../../types';

/** 部署中心主工作区属性 */
export interface NginxDeployWorkspaceProps {
  project: DeployProjectContext;
  lifecycleState: Record<string, any>;
  serverState: Record<string, any>;
  targetState: Record<string, any>;
  recordState: Record<string, any>;
  progressState: Record<string, any>;
  serverActionConfig: YTableActionConfig;
  targetActionConfig: YTableActionConfig;
  recordActionConfig: YTableActionConfig;
}
