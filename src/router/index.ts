import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';

const loadBasicLayout = () => import('@/layouts/BasicLayout/index.vue');
const loadDashboard = () => import('@/views/Dashboard/index.vue');
const loadSettings = () => import('@/views/Settings/index.vue');
const loadConsole = () => import('@/views/Console/index.vue');

export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: loadBasicLayout,
    children: [
      { path: '', redirect: '/dashboard' },
      {
        path: '/dashboard',
        name: 'Dashboard',
        component: loadDashboard,
        meta: { title: '控制中心' },
      },
      {
        path: '/settings',
        name: 'Settings',
        component: loadSettings,
        meta: { title: '分流配置' },
      },
      {
        path: '/console',
        name: 'Console',
        component: loadConsole,
        meta: { title: '日志终端' },
      },
    ],
  },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

export default router;
