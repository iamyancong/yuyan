import { ref } from 'vue';
import { listen } from '@tauri-apps/api/event';

export interface VpnLog {
  vpnType: 'fortinet' | 'atrust';
  text: string;
  time: string;
}

const logs = ref<VpnLog[]>([]);
const maxLogLines = 1000;
let isListening = false;

export function useVpnLogs() {
  const getLogs = () => logs.value;
  
  const clearLogs = () => {
    logs.value = [];
  };

  const initLogListener = async () => {
    if (isListening) return;
    isListening = true;

    try {
      await listen<{ vpn_type: string; text: string }>('vpn-log', (event) => {
        const payload = event.payload;
        const now = new Date().toLocaleTimeString();
        
        logs.value.push({
          vpnType: payload.vpn_type === 'Fortinet' ? 'fortinet' : 'atrust',
          text: payload.text,
          time: now,
        });

        // 限制最大日志行数，避免爆内存
        if (logs.value.length > maxLogLines) {
          logs.value.shift();
        }
      });
      console.log('Tauri vpn-log event listener initialized successfully.');
    } catch (e) {
      console.error('Failed to register Tauri log listener:', e);
      isListening = false;
    }
  };

  return {
    logs,
    clearLogs,
    initLogListener,
    getLogs,
  };
}
