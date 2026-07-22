/**
 * 向旧版 archive-save SSE 响应写入错误并正常结束连接。
 * @param {Object} response - Express 响应
 * @param {unknown} error - 下载错误
 */
export function endArchiveSseWithError(response, error) {
  if (response.writableEnded) return;
  const message = error instanceof Error ? error.message : String(error || '下载运行包失败');
  response.write(`data: ${JSON.stringify({ error: message })}\n\n`);
  response.flush?.();
  response.end();
}
