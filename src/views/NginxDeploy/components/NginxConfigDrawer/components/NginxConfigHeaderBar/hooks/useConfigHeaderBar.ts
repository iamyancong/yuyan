import { computed, ref } from 'vue';
import message from 'ant-design-vue/es/message';
import { copyToClipboard } from '@yss-ui/utils';
import type { DeployTarget } from '@/api/deploy';
import { openExternal } from '@/utils/open';
import { resolveConfigHeaderBarMeta } from '../constant';

/** 站点配置顶栏属性接口 */
export interface UseConfigHeaderBarProps {
  /** 关联部署目标 */
  target?: DeployTarget | null;
  /** 当前加载的配置文件路径 */
  configPath?: string;
}

/**
 * 站点配置顶栏交互 Hook
 * @param props 组件属性
 * @returns 顶栏元数据与交互方法
 */
export function useConfigHeaderBar(props: UseConfigHeaderBarProps) {
  const meta = computed(() => resolveConfigHeaderBarMeta(props.target, props.configPath));

  /** 路径复制状态 */
  const copied = ref(false);
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  /** 复制配置文件路径 */
  const handleCopyPath = async () => {
    const path = meta.value.configPathDisplay;
    if (!path || path.includes('未选择') || path.includes('自动推导')) {
      message.warning('当前暂无可复制的配置文件有效路径');
      return;
    }
    const success = await copyToClipboard(path);
    if (success) {
      message.success('配置文件路径已复制到剪贴板');
      copied.value = true;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copied.value = false;
      }, 1600);
    } else {
      message.error('复制路径失败');
    }
  };

  /** 点击访问站点 */
  const handleOpenVisit = () => {
    if (meta.value.visitUrl) {
      openExternal(meta.value.visitUrl);
    }
  };

  return {
    meta,
    copied,
    handleCopyPath,
    handleOpenVisit,
  };
}
