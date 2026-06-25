import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { AntDesignVueResolver } from 'unplugin-vue-components/resolvers';
import path from 'node:path';

/**
 * 按依赖来源拆分构建产物，降低首屏入口包体积并提升浏览器缓存命中率。
 */
const resolveManualChunk = (id: string) => {
  const normalizedId = id.replace(/\\/g, '/');
  if (normalizedId.includes('vite/preload-helper')) return 'vite-preload-helper';
  if (!normalizedId.includes('node_modules')) return undefined;
  if (
    normalizedId.includes('/node_modules/vue/') ||
    normalizedId.includes('/node_modules/vue-router/') ||
    normalizedId.includes('/node_modules/@vue/')
  ) {
    return 'vendor-vue';
  }
  if (normalizedId.includes('/node_modules/@ant-design/icons-vue/')) return 'vendor-antdv-icons';
  if (normalizedId.includes('/node_modules/ant-design-vue/')) return 'vendor-antdv';
  if (normalizedId.includes('/node_modules/@ycwang-dev/components/')) return 'vendor-yss-ui';
  if (normalizedId.includes('/node_modules/monaco-editor/') || normalizedId.includes('/node_modules/monaco-editor-nls/')) return 'vendor-monaco';
  if (
    normalizedId.includes('/node_modules/vxe-table/') ||
    normalizedId.includes('/node_modules/vxe-pc-ui/') ||
    normalizedId.includes('/node_modules/@vxe-ui/') ||
    normalizedId.includes('/node_modules/xe-utils/')
  ) {
    return 'vendor-vxe';
  }
  if (normalizedId.includes('/node_modules/@formily/')) return 'vendor-formily';
  if (normalizedId.includes('/node_modules/@babel/')) return 'vendor-babel';
  return 'vendor';
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    Components({
      dirs: [],
      dts: false,
      resolvers: [
        AntDesignVueResolver({
          importStyle: false,
        }),
      ],
    }),
  ],
  // 解决 Babel 在浏览器运行时依赖 process 的问题
  define: {
    'process.env': {},
  },
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  build: {
    modulePreload: false,
    rollupOptions: {
      output: {
        hoistTransitiveImports: false,
        manualChunks: resolveManualChunk,
      },
    },
  },
});
