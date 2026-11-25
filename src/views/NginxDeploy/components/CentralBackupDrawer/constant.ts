/**
 * 中央灾备抽屉常量与展示字典
 */

export const CENTRAL_BACKUP_TRIGGER_LABELS: Record<string, string> = {
  schedule: '定时调度',
  manual: '手动触发',
};

export const CENTRAL_BACKUP_SECRET_WARNING =
  '备份不包含 DEPLOY_SECRET_KEY，请单独保管，否则恢复后 SSH 密码无法解密';
