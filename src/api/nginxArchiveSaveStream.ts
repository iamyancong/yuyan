/** 旧版归档保存流的最小事件约束。 */
interface ArchiveSaveStreamEvent {
  error?: string;
  finished?: boolean;
}

/**
 * 消费旧版 archive-save SSE 响应，只有明确收到 finished 才算成功。
 * @param response SSE 响应
 * @param onEvent 保存事件回调
 */
export async function consumeNginxArchiveSaveResponse<T extends ArchiveSaveStreamEvent>(
  response: Response,
  onEvent?: (event: T) => void
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('下载响应没有可读取的数据流');

  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;

  /** 消费一行 SSE data 事件。 */
  const consumeEventLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) return;
    const rawJson = trimmed.slice(5).trim();
    const data = JSON.parse(rawJson) as T;
    if (data.error) throw new Error(data.error);
    if (data.finished === true) finished = true;
    onEvent?.(data);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    lines.forEach(consumeEventLine);
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeEventLine(buffer);
  if (!finished) throw new Error('下载连接提前结束，服务端未确认文件已保存');
}
