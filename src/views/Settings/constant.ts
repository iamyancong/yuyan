export interface VpnSettingsForm {
  fortinetHost: string;
  fortinetPort: number;
  fortinetUsername: string;
  fortinetPassword?: string;
  fortinetRoutes: string; // 逗号分隔的网段，例如 192.168.100.0/24

  atrustHost: string;
  atrustPort: number;
  atrustUsername: string;
  atrustPassword?: string;
  atrustRoutes: string; // 高校分流通常服务端下发，但我们也支持自定义
}

export const DEFAULT_FORM_STATE: VpnSettingsForm = {
  fortinetHost: '219.141.235.68',
  fortinetPort: 12345,
  fortinetUsername: 'ssl',
  fortinetPassword: '',
  fortinetRoutes: '192.168.100.0/24',

  atrustHost: '222.240.48.26',
  atrustPort: 60201,
  atrustUsername: 'yssdm',
  atrustPassword: '',
  atrustRoutes: '',
};
