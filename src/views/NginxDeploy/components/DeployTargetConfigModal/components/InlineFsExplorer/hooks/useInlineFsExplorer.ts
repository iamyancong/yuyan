/**
 * 行内文件选择器业务状态 Hook
 * @description 管理行内目录浏览、实时回填与占用防御
 */

import { computed, ref, watch } from 'vue';
import message from 'ant-design-vue/es/message';
import {
  getServerFsRoots,
  listServerFsEntries,
  type RemoteFsEntry,
  type RemoteFsRoot,
} from '@/api/deploy';
import {
  normalizePosix,
  isPathWithinAnyRoot,
  isSubPathOrEqual,
  getEntryOccupant,
  type InlineFsExplorerProps,
  type SelectBreadcrumbSegment,
  type SelectFsEntry,
} from '../constant.ts';

/**
 * 行内文件浏览器状态逻辑
 * @param props 组件属性
 * @param emit 事件发射器
 * @returns 状态与交互操作
 */
export function useInlineFsExplorer(
  props: InlineFsExplorerProps,
  emit: { (e: 'update:modelValue', val: string): void; (e: 'close'): void }
) {
  const loading = ref(false);
  const showHidden = ref(false);
  const roots = ref<RemoteFsRoot[]>([]);
  const activeRoot = ref<RemoteFsRoot | null>(null);
  const currentPath = ref<string>('');
  const rootPath = ref<string>('');
  const selectedPath = ref<string>(props.modelValue ? normalizePosix(props.modelValue) : '');
  const rawEntries = ref<RemoteFsEntry[]>([]);

  /** 实际生效的受限根边界 */
  const effectiveRootPath = computed(() => {
    if (props.lockedRoot) return normalizePosix(props.lockedRoot);
    return rootPath.value ? normalizePosix(rootPath.value) : '';
  });

  /** 当前是否位于受限根顶部 */
  const isAtRoot = computed(() => {
    if (!effectiveRootPath.value || !currentPath.value) return true;
    return normalizePosix(currentPath.value) === effectiveRootPath.value;
  });

  /** 面包屑分段列表 */
  const breadcrumbs = computed<SelectBreadcrumbSegment[]>(() => {
    if (!currentPath.value) return [];
    const normalized = normalizePosix(currentPath.value);
    const parts = normalized.split('/').filter(Boolean);
    const list: SelectBreadcrumbSegment[] = [];
    let accumulated = '';
    const normLocked = props.lockedRoot ? normalizePosix(props.lockedRoot) : '';

    for (let i = 0; i < parts.length; i += 1) {
      accumulated += `/${parts[i]}`;
      const isLast = i === parts.length - 1;
      let isAccessible = isPathWithinAnyRoot(accumulated, roots.value);
      if (normLocked && !isSubPathOrEqual(accumulated, normLocked)) {
        isAccessible = false;
      }
      list.push({
        name: parts[i],
        path: accumulated,
        isLast,
        disabled: !isAccessible,
        disabledReason: !isAccessible ? '超出锁定作用域' : undefined,
      });
    }
    return list;
  });

  /** 表格展示条目，只筛选展示目录及首行虚拟上一级（注入占用信息） */
  const tableEntries = computed<SelectFsEntry[]>(() => {
    const dirEntries: SelectFsEntry[] = rawEntries.value
      .filter((item) => {
        if (item.type !== 'directory') return false;
        if (!showHidden.value && item.name.startsWith('.')) return false;
        return true;
      })
      .map((item) => {
        const fullPath = item.path || normalizePosix(`${currentPath.value}/${item.name}`);
        const occupiedBy = getEntryOccupant(fullPath, props.occupiedMap);
        return {
          ...item,
          path: fullPath,
          occupiedBy,
        };
      });
    if (isAtRoot.value) return dirEntries;
    const parentRow: SelectFsEntry = {
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

  /** 当前选定路径对应的占用者说明 */
  const selectedOccupant = computed(() => {
    const pathToCheck = selectedPath.value || currentPath.value;
    if (!pathToCheck) return undefined;
    return getEntryOccupant(pathToCheck, props.occupiedMap);
  });

  /**
   * 拉取远程指定目录内容。
   * @param targetPath 目标绝对路径
   */
  const fetchDirectory = async (targetPath?: string) => {
    if (!props.server) return;
    if (props.lockedRoot && targetPath && !isSubPathOrEqual(targetPath, props.lockedRoot)) {
      message.warning('所选路径超出当前锁定作用域');
      return;
    }
    if (targetPath && roots.value.length > 0 && !isPathWithinAnyRoot(targetPath, roots.value)) {
      message.warning('所选路径超出当前服务器受限作用域');
      return;
    }
    loading.value = true;
    try {
      const res = await listServerFsEntries(props.server.id, targetPath);
      currentPath.value = res.currentPath;
      rootPath.value = props.lockedRoot ? normalizePosix(props.lockedRoot) : res.rootPath;
      rawEntries.value = res.entries;

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
      if (!serverRoots || serverRoots.length === 0) {
        message.warning('该服务器未配置受限作用域根目录');
        return;
      }

      // 清洗伪根（过滤掉已有部署目标的业务叶子目录）
      const cleanRoots = serverRoots.filter(
        (r) => !r.id.startsWith('target-') && !r.label.startsWith('部署目标')
      );

      // 若指定了 lockedRoot（如当前 Nginx 实例站点根），则强行限定作用域
      if (props.lockedRoot) {
        const normLocked = normalizePosix(props.lockedRoot);
        const matched = (cleanRoots.length > 0 ? cleanRoots : serverRoots).find(
          (r) => normalizePosix(r.path) === normLocked
        );
        const lockedItem: RemoteFsRoot = {
          id: matched?.id || 'locked-scope',
          label: props.scopeLabel || matched?.label || '锁定站点根',
          path: normLocked,
          isDefault: true,
        };
        roots.value = [lockedItem];
        activeRoot.value = lockedItem;
        rootPath.value = normLocked;

        let preferredPath = normLocked;
        if (props.defaultPath) {
          const normDefault = normalizePosix(props.defaultPath);
          if (isSubPathOrEqual(normDefault, normLocked)) {
            preferredPath = normDefault;
          }
        }
        if (props.modelValue) {
          const normModel = normalizePosix(props.modelValue);
          if (isSubPathOrEqual(normModel, normLocked)) {
            preferredPath = normModel;
            selectedPath.value = normModel;
          }
        }
        await fetchDirectory(preferredPath);
        return;
      }

      roots.value = cleanRoots.length > 0 ? cleanRoots : serverRoots;
      const defaultRoot = roots.value.find((r) => r.isDefault) || roots.value[0];
      activeRoot.value = defaultRoot;

      let preferredPath = defaultRoot.path;
      if (props.modelValue) {
        const normModel = normalizePosix(props.modelValue);
        const matched = roots.value.find((r) => normModel.startsWith(normalizePosix(r.path)));
        if (matched) {
          activeRoot.value = matched;
          preferredPath = normModel;
          selectedPath.value = normModel;
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
    if (props.lockedRoot && !isSubPathOrEqual(parentPath, props.lockedRoot)) {
      message.info('已到达当前受限根目录顶部');
      return;
    }
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
   * 判断某行是否处于当前选定状态。
   * @param entry 目录条目
   * @returns 是否已被选定
   */
  const isRowSelected = (entry: RemoteFsEntry): boolean => {
    if (!selectedPath.value) return false;
    const normSelected = normalizePosix(selectedPath.value);
    if (entry.type === 'parent_dir') {
      return normSelected === normalizePosix(currentPath.value);
    }
    const itemFullPath = normalizePosix(entry.path || `${currentPath.value}/${entry.name}`);
    return normSelected === itemFullPath;
  };

  /**
   * 单击行：高亮并实时回填选定路径（若未占用）。
   * @param entry 行条目
   */
  const handleRowClick = (entry: RemoteFsEntry) => {
    if (entry.type === 'directory') {
      const fullPath = entry.path || normalizePosix(`${currentPath.value}/${entry.name}`);
      selectedPath.value = fullPath;
      const occupant = getEntryOccupant(fullPath, props.occupiedMap);
      if (occupant) {
        message.warning(`该目录已被 ${occupant} 占用，不可复用`);
      } else {
        emit('update:modelValue', fullPath);
        message.success({ content: `已选定: ${fullPath}`, key: 'inline-fs-select', duration: 1.5 });
      }
    } else if (entry.type === 'parent_dir') {
      selectedPath.value = currentPath.value;
      const occupant = getEntryOccupant(currentPath.value, props.occupiedMap);
      if (!occupant) {
        emit('update:modelValue', currentPath.value);
      }
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

  // 挂载时立即拉取允许根
  watch(
    () => props.server?.id,
    (serverId) => {
      if (serverId) void initRootsAndBrowse();
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
    selectedOccupant,
    isAtRoot,
    breadcrumbs,
    tableEntries,
    fetchDirectory,
    navigateUp,
    drillDown,
    handleRowClick,
    handleRowDblClick,
    isRowSelected,
  };
}
