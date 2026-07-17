import message, { type MessageApi, type MessageArgsProps } from 'ant-design-vue/es/message';

/** 全局同时展示的消息数量上限。 */
const GLOBAL_MESSAGE_MAX_COUNT = 3;

/** 全局消息是否已经完成初始化。 */
let configured = false;

/**
 * 为纯文本消息生成稳定哈希。
 * @param value 消息类型与文本组合
 * @returns 无符号哈希字符串
 */
const createStableHash = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

/**
 * 获取可安全去重的纯文本内容。
 * @param content Ant Design Vue 消息内容
 * @returns 纯文本；VNode 或渲染函数返回空字符串
 */
const getPlainMessageContent = (content: MessageArgsProps['content']): string => {
  return typeof content === 'string' || typeof content === 'number' ? String(content).trim() : '';
};

/**
 * 配置全局消息数量限制，并合并当前仍可见的同类型同文案提示。
 * @description 显式传入 key 的 loading → success 更新链路保持原样；VNode 消息不参与自动去重。
 */
export const configureGlobalMessage = (): void => {
  if (configured) return;
  configured = true;

  const originalOpen: MessageApi['open'] = message.open.bind(message);
  message.open = ((args: MessageArgsProps) => {
    const content = getPlainMessageContent(args.content);
    if (args.key !== undefined || !content) return originalOpen(args);
    const type = args.type || 'info';
    return originalOpen({
      ...args,
      key: `global-message-${type}-${createStableHash(content)}`,
    });
  }) as MessageApi['open'];

  message.config({ maxCount: GLOBAL_MESSAGE_MAX_COUNT });
};
