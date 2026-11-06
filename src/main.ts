import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import { configureGlobalMessage } from '@/utils/globalMessage';
import { configureGlobalNotification } from '@/utils/globalNotification';
import { configureGlobalInputBehavior } from '@/utils/configureGlobalInputBehavior';
import 'ant-design-vue/dist/reset.css';
import '@yss-ui/components/dist/style.css';

// Monaco 及其语言支持包（json/yaml）不再随入口加载，改由 virtual:yss-heavy-components
// 在首个 Monaco 消费者（配置/日志/对比抽屉）加载时按需注册，见 vite.config.ts。

configureGlobalMessage();
configureGlobalNotification();
configureGlobalInputBehavior();
const app = createApp(App);
app.use(router);
app.mount('#app');
