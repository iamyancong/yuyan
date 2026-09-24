/**
 * 远程文件工具栏常量与类型定义
 */

import type { BreadcrumbSegment } from '../../constant';

/** 工具栏属性接口 */
export interface RemoteFsToolbarProps {
  pathInput: string;
  currentPath: string;
  isAtRoot: boolean;
  loading: boolean;
  showHidden?: boolean;
  filterKeyword: string;
  breadcrumbs: BreadcrumbSegment[];
}

/** 工具栏事件声明 */
export type RemoteFsToolbarEmits = {
  (e: 'update:pathInput', val: string): void;
  (e: 'update:showHidden', val: boolean): void;
  (e: 'update:filterKeyword', val: string): void;
  (e: 'navigateUp'): void;
  (e: 'refresh'): void;
  (e: 'navigateToPath'): void;
  (e: 'copyPath', path: string): void;
  (e: 'jumpBreadcrumb', path: string): void;
};
