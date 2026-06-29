import { message } from 'ant-design-vue';
import type { Ref } from 'vue';
import type { CreateMicroAppResponse } from '@/api/scaffold';

/** 脚手架创建结果。 */
type ScaffoldResult = CreateMicroAppResponse['data'] | null;

/**
 * 脚手架生成包下载逻辑。
 * @param result 创建结果
 * @returns 下载处理函数
 */
export const useScaffoldDownload = (result: Ref<ScaffoldResult>) => {
  /**
   * 下载脚手架生成包。
   */
  const handleDownload = async () => {
    const downloadPath = result.value?.downloadPath;
    if (!downloadPath) return;

    try {
      const response = await fetch(downloadPath, { credentials: 'include' });
      if (!response.ok) {
        const text = await response.text();
        let errorMessage = text || '下载失败';
        try {
          const parsed = JSON.parse(text);
          errorMessage = parsed?.error || parsed?.message || errorMessage;
        } catch {
          errorMessage = text || errorMessage;
        }
        throw new Error(errorMessage);
      }

      const blob = await response.blob();
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `${result.value?.appName || 'dataService-app'}.zip`;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => window.URL.revokeObjectURL(blobUrl), 1000);
      message.success('下载已开始');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '下载失败');
    }
  };

  return {
    handleDownload,
  };
};
