/** SSE 原始事件帧。 */
export interface SseFrame {
  id: string;
  event: string;
  data: string;
}

/** SSE 增量解析器。 */
export interface SseFrameParser {
  /** 追加一个可能不完整的文本分块。 */
  push: (chunk: string) => void;
  /** 消费流结束时残留的完整帧。 */
  finish: () => void;
}

/** Agent SSE 重连基础延时。 */
const AGENT_RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

/**
 * 计算带 20% 抖动的 Agent SSE 重连延时。
 * @param attempt 连续重连次数
 * @param random 随机数来源，测试时可注入
 * @returns 重连延时毫秒数
 */
export function getAgentReconnectDelay(attempt: number, random: () => number = Math.random): number {
  const base = AGENT_RECONNECT_DELAYS[Math.min(Math.max(0, attempt), AGENT_RECONNECT_DELAYS.length - 1)];
  return Math.round(base * (0.9 + random() * 0.2));
}

/**
 * 创建支持跨 chunk、CRLF、多行 data 和注释心跳的 SSE 解析器。
 * @param onFrame 完整事件回调
 * @returns 增量解析器
 */
export function createSseFrameParser(onFrame: (frame: SseFrame) => void): SseFrameParser {
  let buffer = '';

  /** 解析一个不含空行分隔符的 SSE 帧。 */
  const consumeFrame = (rawFrame: string) => {
    if (!rawFrame.trim()) return;
    let id = '';
    let event = 'message';
    const dataLines: string[] = [];
    rawFrame.split(/\r?\n/).forEach((line) => {
      if (!line || line.startsWith(':')) return;
      const separatorIndex = line.indexOf(':');
      const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
      const rawValue = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : '';
      const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
      if (field === 'id') id = value;
      else if (field === 'event') event = value || 'message';
      else if (field === 'data') dataLines.push(value);
    });
    if (dataLines.length) onFrame({ id, event, data: dataLines.join('\n') });
  };

  /** 消费缓冲区内所有以空行结束的帧。 */
  const drain = () => {
    while (true) {
      const separator = buffer.match(/\r?\n\r?\n/);
      if (!separator || separator.index === undefined) return;
      const rawFrame = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      consumeFrame(rawFrame);
    }
  };

  return {
    push(chunk) {
      buffer += chunk;
      drain();
    },
    finish() {
      drain();
      if (buffer.trim()) consumeFrame(buffer);
      buffer = '';
    },
  };
}
