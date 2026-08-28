import type { DeployRecord } from '@/api/deploy';
import { getDeployRecordCommitMessage, getDeployRecordShortCommit } from '../../constant';

/**
 * 提取提交信息。
 * @param record 发布记录
 * @returns 提交信息文案
 */
export const getCommitMessageText = (record?: Pick<DeployRecord, 'commitMessage'> | null): string => {
  return getDeployRecordCommitMessage(record);
};

/**
 * 提取短 Commit SHA。
 * @param record 发布记录
 * @returns 短 Commit
 */
export const getShortCommitSha = (record?: Pick<DeployRecord, 'commitSha'> | null): string => {
  return getDeployRecordShortCommit(record);
};
