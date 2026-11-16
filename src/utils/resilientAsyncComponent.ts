/**
 * 懒加载组件容错（#61）。
 * @description 镜像更新后旧标签页里的 chunk 哈希已不存在，懒加载会 404，按钮点了没反应。
 * 这里失败先自动重试一次，仍失败提示「页面已更新，请刷新」；同时处理 Vite 的 vite:preloadError。
 */
import { defineAsyncComponent, type AsyncComponentLoader, type Component } from 'vue';
import Modal from 'ant-design-vue/es/modal';

/** 重试前等待毫秒数 */
const RETRY_DELAY_MS = 300;

let promptOpen = false;

/**
 * 提示页面已更新并引导刷新（同一时间只弹一个）。
 */
export function promptPageUpdated() {
  if (promptOpen || typeof window === 'undefined') return;
  promptOpen = true;
  Modal.confirm({
    title: '页面已更新',
    content: '页面已更新，请刷新后继续操作。',
    okText: '刷新',
    cancelText: '稍后',
    onOk: () => window.location.reload(),
    onCancel: () => {
      promptOpen = false;
    },
  });
}

/**
 * 创建带自动重试与刷新提示的懒加载组件。
 * @param loader 组件加载函数
 * @returns 异步组件
 */
export function defineResilientAsyncComponent<T extends Component = Component>(loader: AsyncComponentLoader<T>) {
  return defineAsyncComponent<T>({
    loader,
    onError(error, retry, fail, attempts) {
      if (attempts <= 1) {
        setTimeout(retry, RETRY_DELAY_MS);
        return;
      }
      console.warn('[yuyan] 懒加载组件失败，提示刷新页面', error);
      promptPageUpdated();
      fail();
    },
  });
}

/**
 * 监听 Vite 预加载失败（chunk 依赖 404）。
 * @description 不阻止默认抛错，让 defineResilientAsyncComponent 的重试逻辑接手；这里只负责提示刷新。
 */
export function installChunkLoadErrorHandler() {
  if (typeof window === 'undefined') return;
  window.addEventListener('vite:preloadError', () => {
    promptPageUpdated();
  });
}
