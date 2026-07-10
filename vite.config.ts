import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';
import Components from 'unplugin-vue-components/vite';
import { AntDesignVueResolver } from 'unplugin-vue-components/resolvers';
import path from 'node:path';
import pkg from './package.json';


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
  if (normalizedId.includes('/node_modules/@univerjs/')) return 'vendor-univerjs';
  if (
    normalizedId.includes('/node_modules/react/') ||
    normalizedId.includes('/node_modules/react-dom/') ||
    normalizedId.includes('/node_modules/@radix-ui/') ||
    normalizedId.includes('/node_modules/@floating-ui/') ||
    normalizedId.includes('/node_modules/sonner/')
  ) {
    return 'vendor-react-deps';
  }
  return 'vendor';
};

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const appServerUrl = env.VITE_APP_SERVER_URL || 'http://127.0.0.1:3100';
  const gitlabHostDefault = env.VITE_GITLAB_HOST || 'http://192.168.167.142:8081';

  return {
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
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    server: {
      port: 1420,
      strictPort: true,
      host: '127.0.0.1',
      proxy: {
        '/deploy-api': {
          target: appServerUrl,
          changeOrigin: true,
        },
        '/scaffold-api': {
          target: appServerUrl,
          changeOrigin: true,
        },
        '/api': {
          target: gitlabHostDefault,
          changeOrigin: true,
          router: (req) => {
            const gitlabHost = req.headers['x-gitlab-host'];
            return typeof gitlabHost === 'string' ? gitlabHost : undefined;
          },
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
        '@yss-ui/components': path.resolve(__dirname, 'node_modules/@ycwang-dev/components'),
        '@yss-ui/hooks': path.resolve(__dirname, 'node_modules/@ycwang-dev/hooks'),
        '@yss-ui/utils': path.resolve(__dirname, 'node_modules/@ycwang-dev/utils'),
      },
    },
    build: {
      modulePreload: false,
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        onwarn(warning, warn) {
          if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('"use client"')) {
            return;
          }
          warn(warning);
        },
        output: {
          hoistTransitiveImports: false,
          manualChunks: resolveManualChunk,
        },
      },
    },
  };
});
