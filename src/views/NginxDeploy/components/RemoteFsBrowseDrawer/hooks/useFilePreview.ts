/**
 * 远程文件只读预览 Hook
 * @description 管理文本预览弹窗显隐、大小限制判定及文件内容读取
 */

import { ref } from 'vue';
import message from 'ant-design-vue/es/message';
import { readServerFsContent, type DeployServer, type RemoteFsEntry } from '@/api/deploy';
import { formatFileSize } from '../constant';

/** 文本预览最大字节数 (512KB) */
const MAX_PREVIEW_BYTES = 512 * 1024;

export function useFilePreview(props: { server?: DeployServer | null }) {
  const previewVisible = ref(false);
  const previewLoading = ref(false);
  const previewFileName = ref('');
  const previewFilePath = ref('');
  const previewContent = ref('');
  const previewSize = ref<number | null>(null);

  /**
   * 打开只读预览弹窗
   * @param entry 文件条目
   */
  const openPreview = async (entry: RemoteFsEntry) => {
    const serverId = props.server?.id;
    if (!serverId) return;

    if (entry.size !== null && entry.size > MAX_PREVIEW_BYTES) {
      message.warning(`该文件大小为 ${formatFileSize(entry.size)}，超出 512KB 在线预览上限`);
      return;
    }

    previewFileName.value = entry.name;
    previewFilePath.value = entry.path;
    previewSize.value = entry.size;
    previewContent.value = '';
    previewVisible.value = true;
    previewLoading.value = true;

    try {
      const res = await readServerFsContent(serverId, entry.path);
      previewContent.value = res.content || '';
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '读取文件内容失败');
      previewVisible.value = false;
    } finally {
      previewLoading.value = false;
    }
  };

  /**
   * 关闭只读预览弹窗
   */
  const closePreview = () => {
    previewVisible.value = false;
    previewContent.value = '';
  };

  return {
    previewVisible,
    previewLoading,
    previewFileName,
    previewFilePath,
    previewContent,
    previewSize,
    openPreview,
    closePreview,
  };
}
