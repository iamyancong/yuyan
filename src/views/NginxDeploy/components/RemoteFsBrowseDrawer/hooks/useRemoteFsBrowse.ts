/**
 * 远程文件系统浏览状态机 Hook
 * @description 封装桌面级文件列表交互、双击下钻/双击..上钻、面包屑计算与允许根切换
 */

import { computed, ref, watch } from 'vue';
import message from 'ant-design-vue/es/message';
import {
  getServerFsRoots,
  listServerFsEntries,
  type DeployServer,
  type RemoteFsEntry,
  type RemoteFsRoot,
} from '@/api/deploy';
import {
  normalizePosix,
  isPathWithinAnyRoot,
  isSubPathOrEqual,
  type BreadcrumbSegment,
} from '../constant';

export type { BreadcrumbSegment } from '../constant';

export function useRemoteFsBrowse(
  props: { open: boolean; server?: DeployServer | null; initialPath?: string },
  emit: { (e: 'selectPath', path: string): void; (e: 'update:open', val: boolean): void }
) {
  const loading = ref(false);
  const showHidden = ref(false);
  const roots = ref<RemoteFsRoot[]>([]);
  const currentPath = ref<string>('');
  const rootPath = ref<string>('');
  const isAtRoot = ref(true);
  const truncated = ref(false);
  const rawEntries = ref<RemoteFsEntry[]>([]);
  const selectedEntry = ref<RemoteFsEntry | null>(null);

  /** 当前激活的根对象 */
  const activeRoot = computed(() => {
    return roots.value.find((r) => r.path === rootPath.value) || roots.value[0] || null;
  });

  /**
   * 表格呈现条目：支持隐藏文件/文件夹过滤，非根目录时注入虚拟 .. (返回上一级) 项
   */
  const tableEntries = computed<RemoteFsEntry[]>(() => {
    const list = rawEntries.value.filter((item) => {
      if (!showHidden.value && item.name.startsWith('.')) return false;
      return true;
    });
    if (!isAtRoot.value && currentPath.value && currentPath.value !== '/') {
      const parentDir = normalizePosix(currentPath.value.split('/').slice(0, -1).join('/') || '/');
      const parentEntry: RemoteFsEntry = {
        name: '..',
        path: parentDir,
        type: 'parent_dir',
        size: null,
        mtime: null,
        permissions: 'drwxr-xr-x',
        readable: true,
      };
      return [parentEntry, ...list];
    }
    return list;
  });

  /**
   * 面包屑导航列表（超出允许根边界的祖先段置为 disabled，防止越权 403）
   */
  const breadcrumbs = computed<BreadcrumbSegment[]>(() => {
    if (!currentPath.value) return [];
    const segments = currentPath.value.split('/').filter(Boolean);
    const result: BreadcrumbSegment[] = [];
    let accumulated = '';

    segments.forEach((seg, idx) => {
      accumulated += `/${seg}`;
      const isLast = idx === segments.length - 1;
      const isAccessible = isPathWithinAnyRoot(accumulated, roots.value);
      result.push({
        name: seg,
        path: accumulated,
        isLast,
        disabled: !isAccessible,
        disabledReason: !isAccessible ? '当前受限作用域无法访问上级目录' : undefined,
      });
    });

    return result;
  });

  /**
   * 加载指定目录
   * @param targetPath 目标路径
   */
  const fetchDirectory = async (targetPath?: string) => {
    const serverId = props.server?.id;
    if (!serverId) return;
    if (targetPath && roots.value.length > 0 && !isPathWithinAnyRoot(targetPath, roots.value)) {
      message.warning('所选路径超出当前服务器受限作用域');
      return;
    }
    loading.value = true;
    try {
      const res = await listServerFsEntries(serverId, targetPath);
      currentPath.value = res.currentPath;
      rootPath.value = res.rootPath;
      isAtRoot.value = res.isAtRoot;
      truncated.value = res.truncated;
      rawEntries.value = res.entries || [];
      selectedEntry.value = null;
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '读取远程目录失败');
    } finally {
      loading.value = false;
    }
  };

  /**
   * 初始化允许根与首屏目录
   */
  const initRootsAndBrowse = async () => {
    const serverId = props.server?.id;
    if (!serverId) return;
    loading.value = true;
    try {
      const { roots: serverRoots } = await getServerFsRoots(serverId);
      roots.value = serverRoots || [];
      if (roots.value.length === 0) {
        message.warning('当前服务器未配置前端或 Nginx 允许根目录');
        return;
      }

      // 若指定了初始路径且在合法根内，优先进入初始路径
      const targetInitial = props.initialPath ? normalizePosix(props.initialPath) : '';
      const matchedRoot = targetInitial ? roots.value.find((r) => targetInitial.startsWith(r.path)) : null;

      if (matchedRoot) {
        await fetchDirectory(targetInitial);
      } else {
        const defaultRoot = roots.value.find((r) => r.isDefault) || roots.value[0];
        await fetchDirectory(defaultRoot.path);
      }
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '获取服务器允许根失败');
    } finally {
      loading.value = false;
    }
  };

  /**
   * 返回上一级目录
   */
  const navigateUp = () => {
    if (isAtRoot.value) {
      message.info('已到达当前允许根目录顶部');
      return;
    }
    const parts = currentPath.value.split('/').filter(Boolean);
    if (parts.length <= 1) return;
    const parentPath = `/${parts.slice(0, -1).join('/')}`;
    if (!isPathWithinAnyRoot(parentPath, roots.value)) {
      message.info('已到达当前允许根目录顶部');
      return;
    }
    void fetchDirectory(parentPath);
  };

  /**
   * 钻进子目录
   * @param dirName 子目录名称
   */
  const drillDown = (dirName: string) => {
    const nextPath = `${currentPath.value.replace(/\/$/, '')}/${dirName}`;
    void fetchDirectory(nextPath);
  };

  /**
   * 切换快捷根
   * @param root 允许根对象
   */
  const switchRoot = (root: RemoteFsRoot) => {
    if (currentPath.value === root.path) return;
    void fetchDirectory(root.path);
  };

  /**
   * 单击表格行：仅选中高亮，不导航
   * @param record 行条目
   */
  const handleRowClick = (record: RemoteFsEntry) => {
    selectedEntry.value = record;
  };

  /**
   * 双击表格行：导航下钻或上钻
   * @param record 行条目
   * @param onFilePreview 文件双击回调
   */
  const handleRowDblClick = (record: RemoteFsEntry, onFilePreview?: (entry: RemoteFsEntry) => void) => {
    if (record.type === 'parent_dir') {
      navigateUp();
    } else if (record.type === 'directory') {
      drillDown(record.name);
    } else if (record.type === 'file') {
      onFilePreview?.(record);
    }
  };

  /**
   * 回填部署路径
   */
  const useCurrentPath = () => {
    const pathValue = selectedEntry.value && selectedEntry.value.type === 'directory'
      ? selectedEntry.value.path
      : currentPath.value;
    emit('selectPath', pathValue);
    emit('update:open', false);
    message.success(`已选择路径: ${pathValue}`);
  };

  watch(
    () => props.open,
    (isOpen) => {
      if (isOpen && props.server) {
        void initRootsAndBrowse();
      } else {
        rawEntries.value = [];
        selectedEntry.value = null;
      }
    },
    { immediate: true }
  );

  return {
    loading,
    showHidden,
    roots,
    activeRoot,
    currentPath,
    rootPath,
    isAtRoot,
    truncated,
    tableEntries,
    selectedEntry,
    breadcrumbs,
    fetchDirectory,
    navigateUp,
    drillDown,
    switchRoot,
    handleRowClick,
    handleRowDblClick,
    useCurrentPath,
  };
}
