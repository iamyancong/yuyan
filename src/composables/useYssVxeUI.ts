import { getCurrentInstance } from 'vue';
import type { App, Plugin } from 'vue';
import { VxeUI } from 'vxe-pc-ui';

const YSS_VXE_UI_INSTALLED_FLAG = '__yss_vxe_ui_installed__';

interface YssVxeApp extends App {
  [YSS_VXE_UI_INSTALLED_FLAG]?: boolean;
}

/**
 * 按需注册 YTable 依赖的 VxeUI 插件。
 * @returns 是否完成本次注册
 */
export const useYssVxeUI = () => {
  const instance = getCurrentInstance();
  const app = instance?.appContext.app as YssVxeApp | undefined;

  if (!app || app[YSS_VXE_UI_INSTALLED_FLAG]) {
    return false;
  }

  app.use(VxeUI as unknown as Plugin);
  app[YSS_VXE_UI_INSTALLED_FLAG] = true;
  return true;
};
