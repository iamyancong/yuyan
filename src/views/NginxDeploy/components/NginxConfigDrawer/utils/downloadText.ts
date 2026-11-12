/**
 * 以浏览器下载方式保存文本文件（UTF-8，不追加 BOM，保持与服务器文件字节一致）。
 * @param content 文本内容
 * @param fileName 文件名
 */
export function downloadTextFile(content: string, fileName: string): void {
  const blobUrl = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  try {
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = fileName;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }
}
