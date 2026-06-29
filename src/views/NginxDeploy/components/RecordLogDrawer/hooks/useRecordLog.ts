import { computed, nextTick, ref, watch } from 'vue';
import type { DeployRecord } from '@/api/deploy';
import {
  formatDeployDateTime,
  formatDeployRecordRef,
  getDeployRecordActionLabel,
  getDeployRecordCommitAuthor,
  getDeployRecordCommitMessage,
  getDeployRecordOperator,
  getDeployRecordShortCommit,
} from '../../../constant';
import { formatEmptyText, formatLogItem, getStatusLabel, type RecordSummaryItem } from '../constant';

/** YMonaco 日志模式暴露方法 */
interface MonacoLogViewerExpose {
  layout?: () => void;
  scrollToBottom: () => void;
}

/** 首次打开抽屉时 Monaco 懒加载和抽屉动画可能晚于内容更新，滚动需要短暂重试 */
const RECORD_LOG_SCROLL_RETRY_TIMES = 10;

/** 历史日志滚动重试间隔 */
const RECORD_LOG_SCROLL_RETRY_DELAY = 120;

/**
 * 发布日志展示逻辑 Hook
 * @param props 组件属性
 */
export function useRecordLog(props: { open: boolean; record: DeployRecord | null }) {
  /** 历史日志 Monaco 实例引用 */
  const logMonacoRef = ref<MonacoLogViewerExpose | null>(null);
  let scrollSequence = 0;

  /** 发布日志文本 */
  const recordLogContent = computed(() => {
    const logs = props.record?.logs ?? [];
    if (!logs.length) return '暂无发布日志';
    return logs.map(formatLogItem).join('\n');
  });

  /**
   * 获取 GitLab 提交记录页面链接。
   * @param record 发布记录
   * @returns 提交记录页面链接，无法获取时返回空字符串
   */
  const getCommitUrl = (record: DeployRecord): string => {
    const commitSha = record.commitSha;
    if (!commitSha) return '';

    // 1. 优先使用数据库中存储的 projectPath 拼接本地配置的 GitLab Host
    const gitlabHost = localStorage.getItem('gitlab-host') || import.meta.env.VITE_GITLAB_HOST || '';
    const host = gitlabHost.replace(/\/+$/, '').replace(/\/api\/v4$/, '');
    const projectPath = record.projectPath || '';

    if (projectPath) {
      return `${host}/${projectPath}/-/commit/${commitSha}`;
    }

    // 2. 兜底逻辑：尝试解析 repositoryUrl
    const repoUrl = record.repositoryUrl || '';
    if (repoUrl) {
      if (repoUrl.startsWith('http://') || repoUrl.startsWith('https://')) {
        const baseUrl = repoUrl.replace(/\.git$/i, '');
        return `${baseUrl}/-/commit/${commitSha}`;
      } else if (repoUrl.includes('@')) {
        const match = repoUrl.match(/@([^:/]+)(?::\d+)?[:/](.+)$/i);
        if (match) {
          const hostName = match[1];
          const repoPath = match[2].replace(/\.git$/i, '');
          // 尝试从 host 中提取端口
          let portPart = '';
          try {
            const urlObj = new URL(host);
            if (urlObj.port) portPart = `:${urlObj.port}`;
          } catch (e) {}
          return `${host.startsWith('https') ? 'https' : 'http'}://${hostName}${portPart}/${repoPath}/-/commit/${commitSha}`;
        }
      }
    }

    return '';
  };

  /** 发布记录摘要 */
  const recordSummaries = computed<RecordSummaryItem[]>(() => {
    const record = props.record;
    if (!record) return [];
    const commitUrl = getCommitUrl(record);
    return [
      { label: '项目', value: formatEmptyText(record.projectName) },
      { label: '状态', value: getStatusLabel(record.status) },
      { label: '操作类型', value: getDeployRecordActionLabel(record) },
      { label: '操作人', value: getDeployRecordOperator(record) },
      { label: '分支', value: formatEmptyText(record.branch) },
      { label: '当前生效Commit', value: getDeployRecordShortCommit(record), link: commitUrl || undefined },
      { label: '当前生效提交信息', value: getDeployRecordCommitMessage(record), link: commitUrl || undefined },
      { label: '当前生效提交人', value: getDeployRecordCommitAuthor(record) },
      { label: '来源记录', value: formatDeployRecordRef(record.sourceRecordId) },
      { label: '可恢复版本', value: formatDeployRecordRef(record.backupRecordId) },
      { label: '开始时间', value: formatDeployDateTime(record.startedAt) },
      { label: '结束时间', value: formatDeployDateTime(record.finishedAt) },
      { label: '环境', value: formatEmptyText(record.envName) },
    ];
  });


  /** 滚动历史日志到底部 */
  const scrollRecordLogsToBottom = async (retryCount = 0, sequence = ++scrollSequence) => {
    await nextTick();
    window.requestAnimationFrame(() => {
      if (!props.open || sequence !== scrollSequence) return;

      logMonacoRef.value?.layout?.();
      logMonacoRef.value?.scrollToBottom();

      if (retryCount >= RECORD_LOG_SCROLL_RETRY_TIMES) return;
      window.setTimeout(() => {
        if (!props.open || sequence !== scrollSequence) return;
        void scrollRecordLogsToBottom(retryCount + 1, sequence);
      }, RECORD_LOG_SCROLL_RETRY_DELAY);
    });
  };

  /**
   * 抽屉展开动画结束后再次触发滚动，确保首次打开时 Monaco 已拥有真实容器尺寸。
   * @param open 抽屉是否处于打开状态
   */
  const handleDrawerAfterOpenChange = (open: boolean) => {
    if (open) {
      void scrollRecordLogsToBottom();
      return;
    }
    scrollSequence += 1;
  };

  watch(
    () => props.open,
    (open) => {
      if (open) {
        void scrollRecordLogsToBottom();
        return;
      }
      scrollSequence += 1;
    }
  );

  watch(recordLogContent, () => {
    if (props.open) void scrollRecordLogsToBottom();
  });

  return {
    logMonacoRef,
    recordLogContent,
    recordSummaries,
    handleDrawerAfterOpenChange,
    scrollRecordLogsToBottom,
  };
}
