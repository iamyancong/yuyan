import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';

const loadBasicLayout = () => import('@/layouts/BasicLayout/index.vue');
const loadScaffold = () => import('@/views/ProjectList/Scaffold/index.vue');
const loadOpsProjects = () => import('@/views/OpsProjects/index.vue');
const loadNginxDeploy = () => import('@/views/NginxDeploy/index.vue');
const loadProjectList = () => import('@/views/ProjectList/index.vue');

export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: loadBasicLayout,
    children: [
      { path: '', redirect: '/scaffold' },
      {
        path: '/scaffold',
        name: 'Scaffold',
        component: loadScaffold,
        meta: { title: '创建微应用' },
      },
      {
        path: '/ops-projects',
        name: 'OpsProjectList',
        component: loadOpsProjects,
        meta: { title: '平台应用列表' },
      },
      {
        path: '/deploy',
        name: 'DeployCenter',
        component: loadNginxDeploy,
        meta: { title: '部署中心' },
      },
      {
        path: '/nginx-deploy',
        redirect: (to) => ({
          path: '/deploy',
          query: to.query,
          hash: to.hash,
        }),
      },
      {
        path: '/projects',
        name: 'ProjectList',
        component: loadProjectList,
        meta: { title: 'GitLab 仓库列表' },
      },
      // {
      //   path: '/code-converter',
      //   name: 'CodeConverter',
      //   component: () => import('@/views/CodeConverter/index.vue'),
      //   meta: { title: 'Vue转JSP工具' },
      // },
    ],
  },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

export default router;
