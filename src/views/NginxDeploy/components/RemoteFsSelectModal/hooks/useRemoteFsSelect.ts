/**
 * 远程目录选择状态机 Hook
 * @description 封装 Finder/资源管理器风格的目录钻取、快捷根切换与路径选定逻辑
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
import { normalizePosix, isPathWithinAnyRoot, isSubPathOrEqual, type SelectBreadcrumbSegment } from '../constant';

/**
 * 远程目录选择状态管理
 * @param props 组件属性
 * @param emit 事件发射器
 * @returns 目录浏览与选择状态及操作方法
 */
export function useRemoteFsSelect(
  props: { open: boolean; server?: DeployServer | null; initialPath?: string },
  emit: { (e: 'update:open', val: boolean): void; (e: 'select', path: string): void }
) {
  const loading = ref(false);
  const showHidden = ref(false);
  const roots = ref<RemoteFsRoot[]>([]);
  const activeRoot = ref<RemoteFsRoot | null>(null);
  const currentPath = ref<string>('');
  const rootPath = ref<string>('');
  const selectedPath = ref<string>('');
  const rawEntries = ref<RemoteFsEntry[]>([]);

  /** 当前是否位于受限根顶部 */
  const isAtRoot = computed(() => {
    if (!rootPath.value || !currentPath.value) return true;
    return normalizePosix(currentPath.value) === normalizePosix(rootPath.value);
  });

  /** 面包屑分段列表（受限根之上的祖先分段自动禁用点击，防止越界 403） */
  const breadcrumbs = computed<SelectBreadcrumbSegment[]>(() => {
    if (!currentPath.value) return [];
    const normalized = normalizePosix(currentPath.value);
    const parts = normalized.split('/').filter(Boolean);
    const list: SelectBreadcrumbSegment[] = [];
    let accumulated = '';
    for (let i = 0; i < parts.length; i += 1) {
      accumulated += `/${parts[i]}`;
      const isLast = i === parts.length - 1;
      const isAccessible = isPathWithinAnyRoot(accumulated, roots.value);
      list.push({
        name: parts[i],
        path: accumulated,
        isLast,
        disabled: !isAccessible,
        disabledReason: !isAccessible ? '当前受限作用域无法向上访问' : undefined,
      });
    }
    return list;
  });

  /** 表格展示条目，只筛选展示目录及首行虚拟上一级（支持隐藏项过滤） */
  const tableEntries = computed<RemoteFsEntry[]>(() => {
    const dirEntries = rawEntries.value.filter((item) => {
      if (item.type !== 'directory') return false;
      if (!showHidden.value && item.name.startsWith('.')) return false;
      return true;
    });
    if (isAtRoot.value) return dirEntries;
    const parentRow: RemoteFsEntry = {
      name: '..',
      path: '..',
      type: 'parent_dir',
      extension: '',
      size: null,
      mtime: null,
      permissions: 'drwxr-xr-x',
      readable: true,
    };
    return [parentRow, ...dirEntries];
  });

  /**
   * 拉取远程指定目录内容。
   * @param targetPath 目标绝对路径
   */
  const fetchDirectory = async (targetPath?: string) => {
    if (!props.server) return;
    if (targetPath && roots.value.length > 0 && !isPathWithinAnyRoot(targetPath, roots.value)) {
      message.warning('所选路径超出当前服务器受限作用域');
      return;
    }
    loading.value = true;
    try {
      const res = await listServerFsEntries(props.server.id, targetPath);
      currentPath.value = res.currentPath;
      rootPath.value = res.rootPath;
      rawEntries.value = res.entries;
      selectedPath.value = res.currentPath;

      const matchedRoot = roots.value.find((r) => r.path === res.rootPath);
      if (matchedRoot) activeRoot.value = matchedRoot;
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '读取远程目录失败');
    } finally {
      loading.value = false;
    }
  };

  /**
   * 初始化服务器允许根并进入首个安全目录。
   */
  const initRootsAndBrowse = async () => {
    if (!props.server) return;
    loading.value = true;
    try {
      const { roots: serverRoots } = await getServerFsRoots(props.server.id);
      roots.value = serverRoots;
      if (!serverRoots || serverRoots.length === 0) {
        message.warning('该服务器未配置受限作用域根目录');
        return;
      }

      const defaultRoot = serverRoots.find((r) => r.isDefault) || serverRoots[0];
      activeRoot.value = defaultRoot;

      let preferredPath = defaultRoot.path;
      if (props.initialPath) {
        const normalizedInitial = normalizePosix(props.initialPath);
        const matched = serverRoots.find((r) => normalizedInitial.startsWith(normalizePosix(r.path)));
        if (matched) {
          activeRoot.value = matched;
          preferredPath = normalizedInitial;
        }
      }

      await fetchDirectory(preferredPath);
    } catch (error: any) {
      message.error(error?.response?.data?.message || error?.message || '获取服务器允许根失败');
    } finally {
      loading.value = false;
    }
  };

  /**
   * 返回上一级目录。
   */
  const navigateUp = () => {
    if (isAtRoot.value) {
      message.info('已到达当前受限根目录顶部');
      return;
    }
    const parts = currentPath.value.split('/').filter(Boolean);
    if (parts.length <= 1) return;
    const parentPath = `/${parts.slice(0, -1).join('/')}`;
    if (!isPathWithinAnyRoot(parentPath, roots.value)) {
      message.info('已到达当前受限根目录顶部');
      return;
    }
    void fetchDirectory(parentPath);
  };

  /**
   * 钻入子目录。
   * @param dirName 子目录名称
   */
  const drillDown = (dirName: string) => {
    const nextPath = `${currentPath.value.replace(/\/$/, '')}/${dirName}`;
    void fetchDirectory(nextPath);
  };

  /**
   * 切换快捷允许根。
   * @param root 选中的允许根
   */
  const switchRoot = (root: RemoteFsRoot) => {
    if (currentPath.value === root.path) return;
    void fetchDirectory(root.path);
  };

  /**
   * 单击行：高亮并标记选定路径。
   * @param entry 行条目
   */
  const handleRowClick = (entry: RemoteFsEntry) => {
    if (entry.type === 'directory') {
      selectedPath.value = entry.path;
    } else if (entry.type === 'parent_dir') {
      selectedPath.value = currentPath.value;
    }
  };

  /**
   * 双击行：进入子目录或返回上一级。
   * @param entry 行条目
   */
  const handleRowDblClick = (entry: RemoteFsEntry) => {
    if (entry.type === 'parent_dir') {
      navigateUp();
    } else if (entry.type === 'directory') {
      drillDown(entry.name);
    }
  };

  /**
   * 确认选择当前选中的路径并关闭弹窗。
   */
  const confirmSelection = () => {
    const finalPath = selectedPath.value || currentPath.value;
    if (!finalPath) {
      message.warning('请先选择有效的目录');
      return;
    }
    emit('select', finalPath);
    emit('update:open', false);
    message.success(`已选定部署根目录: ${finalPath}`);
  };

  watch(
    () => props.open,
    (isOpen) => {
      if (isOpen && props.server) {
        void initRootsAndBrowse();
      } else {
        rawEntries.value = [];
        selectedPath.value = '';
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
    selectedPath,
    isAtRoot,
    breadcrumbs,
    tableEntries,
    fetchDirectory,
    navigateUp,
    drillDown,
    switchRoot,
    handleRowClick,
    handleRowDblClick,
    confirmSelection,
  };
}
