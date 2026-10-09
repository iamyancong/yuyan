/**
 * 远程文件系统浏览状态机 Hook
 * @description 封装远程目录列表、路径导航、文件过滤与排序、允许根快捷切换与校验
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
  calculateRangeSelection,
  type BreadcrumbSegment,
} from '../constant';

export type { BreadcrumbSegment } from '../constant';

/** 排序字段 */
export type FsSortField = 'name' | 'size' | 'mtime';

/**
 * 管理远程目录读取、路径导航、条目选择、过滤排序和允许根校验。
 * @param props 抽屉打开状态、服务器与初始目录
 * @param emit 路径选择及抽屉显隐事件
 * @returns 目录状态与浏览操作
 */
export function useRemoteFsBrowse(
  props: { open: boolean; server?: DeployServer | null; initialPath?: string },
  emit: { (e: 'selectPath', path: string): void; (e: 'update:open', val: boolean): void }
) {
  const loading = ref(false);
  const showHidden = ref(false);
  const filterKeyword = ref('');
  const sortField = ref<FsSortField>('name');
  const sortAsc = ref(true);

  const roots = ref<RemoteFsRoot[]>([]);
  const currentPath = ref<string>('');
  /** 路径输入框中的待跳转值，与已加载目录分开保存 */
  const pathInput = ref<string>('');
  const isAtRoot = ref(true);
  const truncated = ref(false);
  const rawEntries = ref<RemoteFsEntry[]>([]);
  const selectedEntries = ref<RemoteFsEntry[]>([]);
  const anchorPath = ref<string | null>(null);
  const selectedEntry = ref<RemoteFsEntry | null>(null);

  /** 当前被选中项的路径集合，提供高效高亮命中检测 */
  const selectedPathSet = computed<Set<string>>(
    () => new Set(selectedEntries.value.map((e) => e.path || ''))
  );

  /**
   * 表格呈现条目：支持隐藏文件过滤、关键字过滤与多维排序（文件夹始终置顶）
   */
  const tableEntries = computed<RemoteFsEntry[]>(() => {
    let list = rawEntries.value.filter((item) => {
      if (!showHidden.value && item.name.startsWith('.')) return false;
      if (filterKeyword.value.trim()) {
        const kw = filterKeyword.value.trim().toLowerCase();
        if (!item.name.toLowerCase().includes(kw)) return false;
      }
      return true;
    });

    // 排序逻辑：文件夹永远优先置顶，返回上一级(..)置于最顶部
    list = [...list].sort((a, b) => {
      if (a.type !== b.type) {
        if (a.type === 'directory') return -1;
        if (b.type === 'directory') return 1;
      }
      const dirMultiplier = sortAsc.value ? 1 : -1;
      if (sortField.value === 'name') {
        return dirMultiplier * a.name.localeCompare(b.name);
      }
      if (sortField.value === 'size') {
        const sizeA = a.size ?? -1;
        const sizeB = b.size ?? -1;
        return dirMultiplier * (sizeA - sizeB);
      }
      if (sortField.value === 'mtime') {
        const timeA = a.mtime ?? 0;
        const timeB = b.mtime ?? 0;
        return dirMultiplier * (timeA - timeB);
      }
      return 0;
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

  /** 目录条目分类统计（不含虚拟 .. 行） */
  const dirCount = computed(() => rawEntries.value.filter((e) => e.type === 'directory').length);
  const fileCount = computed(() => rawEntries.value.filter((e) => e.type === 'file').length);

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
   * 切换排序方式
   * @param field 排序字段
   */
  const toggleSort = (field: FsSortField) => {
    if (sortField.value === field) {
      sortAsc.value = !sortAsc.value;
    } else {
      sortField.value = field;
      sortAsc.value = true;
    }
    anchorPath.value = null;
  };

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
      pathInput.value = res.currentPath;
      isAtRoot.value = res.isAtRoot;
      truncated.value = res.truncated;
      rawEntries.value = res.entries || [];
      selectedEntry.value = null;
      selectedEntries.value = [];
      anchorPath.value = null;
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
      const matchedRoot = targetInitial ? roots.value.find((root) => isSubPathOrEqual(targetInitial, root.path)) : null;

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
   * 单击表格行：支持普通单选、Cmd/Ctrl 离散多选与 Shift 范围多选。
   * @param record 行条目
   * @param event 原生鼠标事件（可选，用于判断键盘组合键）
   */
  const handleRowClick = (record: RemoteFsEntry, event?: MouseEvent) => {
    // 虚拟父目录 .. 无法加入多选，仅激活常规单选
    if (record.type === 'parent_dir') {
      selectedEntries.value = [];
      anchorPath.value = null;
      selectedEntry.value = record;
      return;
    }

    // 主动清空可能由于 Shift+点击或拖拽意外残留的浏览器原生文本选区
    if (typeof window !== 'undefined' && window.getSelection) {
      window.getSelection()?.removeAllRanges();
    }

    const currentIdx = tableEntries.value.findIndex((e) => e.path === record.path);

    if (event && (event.metaKey || event.ctrlKey)) {
      // 1. Cmd (macOS) / Ctrl (Windows) 离散多选 / 取消选择
      const existsIndex = selectedEntries.value.findIndex((e) => e.path === record.path);
      if (existsIndex >= 0) {
        selectedEntries.value = selectedEntries.value.filter((e) => e.path !== record.path);
      } else {
        selectedEntries.value = [...selectedEntries.value, record];
      }
      anchorPath.value = record.path;
      selectedEntry.value = selectedEntries.value.length === 1 ? selectedEntries.value[0] : null;
      return;
    }

    if (event && event.shiftKey) {
      // 2. Shift 连续范围多选：依据 anchorPath 动态查找当前可见表格行号
      const anchorIdx = anchorPath.value
        ? tableEntries.value.findIndex((e) => e.path === anchorPath.value)
        : -1;

      if (anchorIdx < 0 || currentIdx < 0) {
        anchorPath.value = record.path;
        selectedEntries.value = [record];
      } else {
        selectedEntries.value = calculateRangeSelection(tableEntries.value, anchorIdx, currentIdx);
      }
      selectedEntry.value = selectedEntries.value.length === 1 ? selectedEntries.value[0] : null;
      return;
    }

    // 3. 普通左键单击：单选重置
    selectedEntries.value = [record];
    anchorPath.value = record.path;
    selectedEntry.value = record;
  };

  /**
   * 一键全选当前可见列表（排除虚拟 .. 行）
   */
  const selectAllEntries = () => {
    const valid = tableEntries.value.filter((e) => e.type !== 'parent_dir');
    selectedEntries.value = valid;
    selectedEntry.value = valid.length === 1 ? valid[0] : null;
    anchorPath.value = valid[0]?.path || null;
  };

  /**
   * 清空当前所有选中项
   */
  const clearSelection = () => {
    selectedEntries.value = [];
    selectedEntry.value = null;
    anchorPath.value = null;
  };

  /**
   * 强制同步选中项列表（如右键菜单切流）
   * @param entries 待设定的条目列表
   */
  const setSelectedEntries = (entries: RemoteFsEntry[]) => {
    const valid = entries.filter((e) => e.type !== 'parent_dir');
    selectedEntries.value = valid;
    selectedEntry.value = valid.length === 1 ? valid[0] : null;
    anchorPath.value = valid[0]?.path || null;
  };

  /**
   * 双击表格行：导航下钻或文件预览
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
   * 复制路径到剪贴板
   * @param path 目标路径
   */
  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      message.success(`已复制路径: ${path}`);
    } catch {
      message.info(`路径: ${path}`);
    }
  };

  /**
   * 批量复制多个路径到剪贴板
   * @param paths 路径数组
   */
  const copyMultiplePaths = async (paths: string[]) => {
    const text = paths.filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      message.success(`已复制 ${paths.length} 项路径`);
    } catch {
      message.info(`已复制 ${paths.length} 项路径`);
    }
  };

  /**
   * 确认选定部署路径并关闭抽屉
   */
  const useCurrentPath = () => {
    const target = selectedEntries.value.length === 1 ? selectedEntries.value[0] : selectedEntry.value;
    const pathValue = target && target.type === 'directory' ? target.path : currentPath.value;
    emit('selectPath', pathValue);
    emit('update:open', false);
    message.success(`已选择路径: ${pathValue}`);
  };

  // 关键：当可见条目变化（如关键字筛选、切换显示隐藏文件、目录切换或排序）时，动态将已选项收敛到当前可见项
  watch(
    tableEntries,
    (visibleList) => {
      if (selectedEntries.value.length === 0) return;
      const visiblePathMap = new Map(visibleList.map((e) => [e.path, e]));
      const nextSelected = selectedEntries.value
        .map((e) => visiblePathMap.get(e.path))
        .filter((e): e is RemoteFsEntry => Boolean(e && e.type !== 'parent_dir'));

      if (nextSelected.length !== selectedEntries.value.length) {
        selectedEntries.value = nextSelected;
        selectedEntry.value = nextSelected.length === 1 ? nextSelected[0] : null;
      }

      if (anchorPath.value && !visiblePathMap.has(anchorPath.value)) {
        anchorPath.value = nextSelected[0]?.path || null;
      }
    },
    { deep: false }
  );

  watch(
    () => props.open,
    (isOpen) => {
      if (isOpen && props.server) {
        filterKeyword.value = '';
        void initRootsAndBrowse();
      } else {
        rawEntries.value = [];
        selectedEntry.value = null;
        selectedEntries.value = [];
        anchorPath.value = null;
        filterKeyword.value = '';
      }
    },
    { immediate: true }
  );

  return {
    loading,
    showHidden,
    filterKeyword,
    sortField,
    sortAsc,
    roots,
    currentPath,
    pathInput,
    isAtRoot,
    truncated,
    tableEntries,
    selectedEntry,
    selectedEntries,
    selectedPathSet,
    dirCount,
    fileCount,
    breadcrumbs,
    toggleSort,
    fetchDirectory,
    navigateUp,
    drillDown,
    handleRowClick,
    handleRowDblClick,
    selectAllEntries,
    clearSelection,
    setSelectedEntries,
    copyPath,
    copyMultiplePaths,
    useCurrentPath,
  };
}
