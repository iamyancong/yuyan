/**
 * 部署目标配置表单常量与类型定义
 */

import type { DeployTargetPayload } from '@/api/deploy';
import type { FormilyRef } from '../../../../types';

/** 部署目标表单属性接口 */
export interface DeployTargetFormProps {
  loading: boolean;
  form: DeployTargetPayload;
  schema: Record<string, unknown>;
  targetId?: number | null;
}

/** 部署目标表单事件定义 */
export interface DeployTargetFormEmits {
  (e: 'update:form', value: Partial<DeployTargetPayload>): void;
  (e: 'formRefChange', value: FormilyRef | null): void;
}
