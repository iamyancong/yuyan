import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import { configureGlobalMessage } from '@/utils/globalMessage';
import { configureMonacoJsonHighlight } from '@/utils/monacoJsonHighlight';
import { configureGlobalInputBehavior } from '@/utils/configureGlobalInputBehavior';
import 'ant-design-vue/dist/reset.css';
import '@yss-ui/components/dist/style.css';

// 导入 Monaco Editor 的语言支持包以启用语法高亮（防止被 Rollup 摇树优化摇掉）
import 'monaco-editor/esm/vs/language/json/monaco.contribution';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';

configureGlobalMessage();
configureMonacoJsonHighlight();
configureGlobalInputBehavior();
const app = createApp(App);
app.use(router);
app.mount('#app');
