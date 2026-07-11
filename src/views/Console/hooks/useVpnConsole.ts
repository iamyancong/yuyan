import { ref, computed, nextTick, watch, onMounted } from 'vue';
import { useVpnLogs } from '@/hooks/useVpnLogs';
import { type LogFilterType } from '../constant';

export function useVpnConsole() {
  const { logs, clearLogs, initLogListener } = useVpnLogs();
  const filterType = ref<LogFilterType>('all');
  const terminalRef = ref<HTMLElement | null>(null);

  // 过滤后的日志
  const filteredLogs = computed(() => {
    if (filterType.value === 'all') return logs.value;
    return logs.value.filter((log) => log.vpnType === filterType.value);
  });

  // 自动滚动到底部
  const scrollToBottom = () => {
    nextTick(() => {
      if (terminalRef.value) {
        terminalRef.value.scrollTop = terminalRef.value.scrollHeight;
      }
    });
  };

  // 当日志增加时，自动触发滚动
  watch(
    () => filteredLogs.value.length,
    () => {
      scrollToBottom();
    }
  );

  onMounted(() => {
    void initLogListener();
    scrollToBottom();
  });

  return {
    filterType,
    filteredLogs,
    terminalRef,
    clearLogs,
  };
}
