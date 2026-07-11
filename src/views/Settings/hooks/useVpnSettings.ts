import { ref, onMounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { message } from 'ant-design-vue';
import { type VpnSettingsForm, DEFAULT_FORM_STATE } from '../constant';

export function useVpnSettings() {
  const formState = ref<VpnSettingsForm>({ ...DEFAULT_FORM_STATE });
  const loading = ref(false);
  const saving = ref(false);

  // 加载本地配置并映射到表单
  const loadConfig = async () => {
    loading.value = true;
    try {
      const res: any = await invoke('load_vpn_config');
      
      formState.value = {
        fortinetHost: res.fortinet.host,
        fortinetPort: res.fortinet.port,
        fortinetUsername: res.fortinet.username,
        fortinetPassword: res.fortinet.password || '',
        fortinetRoutes: res.fortinet.customRoutes ? res.fortinet.customRoutes.join(', ') : '192.168.100.0/24',

        atrustHost: res.atrust.host,
        atrustPort: res.atrust.port,
        atrustUsername: res.atrust.username,
        atrustPassword: res.atrust.password || '',
        atrustRoutes: res.atrust.customRoutes ? res.atrust.customRoutes.join(', ') : '',
      };
    } catch (err: any) {
      message.error(`加载配置失败: ${err}`);
    } finally {
      loading.value = false;
    }
  };

  // 映射表单并保存本地配置
  const saveConfig = async () => {
    saving.value = true;
    try {
      // 解析自定义路由段
      const parseRoutes = (str: string): string[] => {
        return str
          .split(',')
          .map((r) => r.trim())
          .filter((r) => r.length > 0);
      };

      const settingsPayload = {
        fortinet: {
          enabled: true,
          host: formState.value.fortinetHost,
          port: formState.value.fortinetPort,
          username: formState.value.fortinetUsername,
          password: formState.value.fortinetPassword || '',
          savePassword: true,
          customRoutes: parseRoutes(formState.value.fortinetRoutes),
        },
        atrust: {
          enabled: true,
          host: formState.value.atrustHost,
          port: formState.value.atrustPort,
          username: formState.value.atrustUsername,
          password: formState.value.atrustPassword || '',
          savePassword: true,
          customRoutes: parseRoutes(formState.value.atrustRoutes),
        },
      };

      await invoke('save_vpn_config', { settings: settingsPayload });
      message.success('VPN 配置保存成功');
    } catch (err: any) {
      message.error(`保存配置失败: ${err}`);
    } finally {
      saving.value = false;
    }
  };

  onMounted(() => {
    void loadConfig();
  });

  return {
    formState,
    loading,
    saving,
    saveConfig,
    loadConfig,
  };
}
