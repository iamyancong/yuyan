import {
  DashboardOutlined,
  SettingOutlined,
  CodeOutlined,
} from '@ant-design/icons-vue';

/**
 * 自定义菜单图标映射关系对象
 */
export const MENU_ICON_MAP: Record<string, any> = {
  Dashboard: DashboardOutlined,
  Settings: SettingOutlined,
  Console: CodeOutlined,
};

/**
 * 根据路由名称获取对应的菜单图标组件
 * @param routeName 路由的 name 标识
 * @returns 返回对应的 Ant Design Vue 图标组件，若未匹配则默认返回 DashboardOutlined
 */
export const getMenuIcon = (routeName: string): any => {
  return MENU_ICON_MAP[routeName] || DashboardOutlined;
};
