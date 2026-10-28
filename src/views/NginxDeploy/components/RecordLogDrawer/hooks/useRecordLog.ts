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
import {
  extractErrorSummaryFromLogs,
  formatEditorDiagnosticBanner,
  formatEmptyText,
  formatLogItem,
  getStatusLabel,
  type LogFilterMode,
  type RecordSummaryItem,
} from '../constant';
import { getGitLabHost } from '@/api/gitlab';
import { useDeployLogHints } from '../../../hooks/useDeployLogHints';

/** YMonaco 日志模式暴露方法 */
interface MonacoLogViewerExpose {
  layout?: () => void;
  scrollToBottom: () => void;
  getInstance?: () => any;
  editor?: any;
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

  /** 白话提示开关（跨抽屉共享） */
  const { showLogHints } = useDeployLogHints();

  /** 日志过滤模式：all 全部 | errors 仅错误与告警 */
  const filterMode = ref<LogFilterMode>('all');

  /** 错误根因诊断信息 */
  const errorSummary = computed(() => {
    return extractErrorSummaryFromLogs(props.record?.logs ?? [], props.record);
  });

  /** 日志总数与异常数统计 */
  const totalLogsCount = computed(() => props.record?.logs?.length ?? 0);
  const errorLogsCount = computed(() => {
    return (props.record?.logs ?? []).filter((l) => l.level === 'error' || l.level === 'warn').length;
  });

  /** 过滤后的日志项列表 */
  const displayedLogs = computed(() => {
    const logs = props.record?.logs ?? [];
    if (filterMode.value === 'errors') {
      return logs.filter((l) => l.level === 'error' || l.level === 'warn');
    }
    return logs;
  });

  /** 发布日志文本（构建失败时在末尾拼接高对比度诊断报告） */
  const recordLogContent = computed(() => {
    if (!displayedLogs.value.length) {
      return filterMode.value === 'errors' ? '当前日志中无错误或告警信息' : '暂无发布日志';
    }
    const baseContent = displayedLogs.value.map((item) => formatLogItem(item, showLogHints.value)).join('\n');
    // 如果构建失败且提取到了错误诊断信息，直接在 Monaco 编辑器末尾呈现 ASCII 终端高亮诊断报告
    if (props.record?.status === 'failed' && errorSummary.value) {
      const banner = formatEditorDiagnosticBanner(errorSummary.value);
      return `${baseContent}\n${banner}`;
    }
    return baseContent;
  });

  /** 定位至错误根因或编辑器内的诊断报告 */
  const jumpToErrorLine = async () => {
    if (!errorSummary.value) return;
    if (filterMode.value !== 'all') {
      filterMode.value = 'all';
    }
    await nextTick();
    const expose = logMonacoRef.value;
    const rawEditor = typeof expose?.getInstance === 'function' ? expose.getInstance() : (expose as any)?.editor;
    if (rawEditor) {
      const lineCount = rawEditor.getModel?.()?.getLineCount() || 99999;
      // 诊断报告通常占 20-30 行，定位到报告标题附近
      const targetLine = Math.max(1, lineCount - 16);
      if (typeof rawEditor.revealLineInCenter === 'function') {
        rawEditor.revealLineInCenter(targetLine);
      }
      if (typeof rawEditor.setPosition === 'function') {
        rawEditor.setPosition({ lineNumber: targetLine, column: 1 });
      }
      if (typeof rawEditor.focus === 'function') {
        rawEditor.focus();
      }
    }
  };

  /**
   * 获取 GitLab 提交记录页面链接。
   * @param record 发布记录
   * @returns 提交记录页面链接，无法获取时返回空字符串
   */
  const getCommitUrl = (record: DeployRecord): string => {
    const commitSha = record.commitSha;
    if (!commitSha) return '';

    // 1. 优先使用数据库中存储的 projectPath 拼接本地配置的 GitLab Host
    const gitlabHost = getGitLabHost();
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


  /** 滚动历史日志（失败时优先聚焦错误根因行，成功或正常状态滚动到底部） */
  const scrollRecordLogsToTarget = async (retryCount = 0, sequence = ++scrollSequence) => {
    await nextTick();
    window.requestAnimationFrame(() => {
      if (!props.open || sequence !== scrollSequence) return;

      logMonacoRef.value?.layout?.();

      // 如果有识别到的致命错误行，优先居中定位到该行
      if (props.record?.status === 'failed' && errorSummary.value?.lineIndex && filterMode.value === 'all') {
        const expose = logMonacoRef.value;
        const rawEditor = typeof expose?.getInstance === 'function' ? expose.getInstance() : (expose as any)?.editor;
        if (rawEditor?.revealLineInCenter) {
          rawEditor.revealLineInCenter(errorSummary.value.lineIndex);
          rawEditor.setPosition?.({ lineNumber: errorSummary.value.lineIndex, column: 1 });
          return;
        }
      }

      logMonacoRef.value?.scrollToBottom();

      if (retryCount >= RECORD_LOG_SCROLL_RETRY_TIMES) return;
      window.setTimeout(() => {
        if (!props.open || sequence !== scrollSequence) return;
        void scrollRecordLogsToTarget(retryCount + 1, sequence);
      }, RECORD_LOG_SCROLL_RETRY_DELAY);
    });
  };

  /**
   * 抽屉展开动画结束后再次触发滚动，确保首次打开时 Monaco 已拥有真实容器尺寸。
   * @param open 抽屉是否处于打开状态
   */
  const handleDrawerAfterOpenChange = (open: boolean) => {
    if (open) {
      void scrollRecordLogsToTarget();
      return;
    }
    scrollSequence += 1;
  };

  watch(
    () => props.open,
    (open) => {
      if (open) {
        void scrollRecordLogsToTarget();
        return;
      }
      scrollSequence += 1;
    }
  );

  watch(recordLogContent, () => {
    if (props.open) void scrollRecordLogsToTarget();
  });

  return {
    logMonacoRef,
    recordLogContent,
    recordSummaries,
    filterMode,
    errorSummary,
    totalLogsCount,
    errorLogsCount,
    jumpToErrorLine,
    handleDrawerAfterOpenChange,
    scrollRecordLogsToBottom: scrollRecordLogsToTarget,
  };
}
