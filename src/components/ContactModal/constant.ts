/**
 * 联系我们（技术支持）组件常量与配置定义
 */
import { buildContactConfig, type ContactInfo } from './contactPolicy';

export type { ContactInfo } from './contactPolicy';

/**
 * 联系人配置（Vite 编译期读取 VITE_CONTACT_*）
 * @description 工号、邮箱、名片未配置时为空，界面隐藏对应项，不再显示占位值。
 */
export const CONTACT_CONFIG: ContactInfo = buildContactConfig(import.meta.env);
