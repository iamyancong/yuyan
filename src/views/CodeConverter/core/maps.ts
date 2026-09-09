// 库名到全局变量的映射配置
export const LIBRARY_MAP: Record<string, string> = {
  'vue': 'Vue',
  'vue-router': 'VueRouter',
  'ant-design-vue': 'antd',
  'vxe-table': 'VXETable',
  'vxe-pc-ui': 'VxeUI', // 或者是 VXETable，视具体版本而定，这里先假设 separation
  'xe-utils': 'XEUtils',
  '@yss-ui/components': 'YssUI',
  'yss-ui': 'YssUI',
  'echarts': 'echarts',
  'dayjs': 'dayjs',
  'axios': 'axios'
};

// 不需要转换的导入（比如类型定义）
export const IGNORED_IMPORTS = [
  'type',
  'interface'
];
