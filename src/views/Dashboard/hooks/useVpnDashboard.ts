import { ref, onMounted, onUnmounted } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { message } from 'ant-design-vue';
import { useVpnLogs } from '@/hooks/useVpnLogs';
import { type VpnStats, VPN_TYPES } from '../constant';

export function useVpnDashboard() {
  const { initLogListener } = useVpnLogs();

  // 两个 VPN 的状态
  const fortinetState = ref<VpnStats>({
    status: 'disconnected',
    virtualIp: null,
    uptime: 0,
    message: '未连接',
  });

  const atrustState = ref<VpnStats>({
    status: 'disconnected',
    virtualIp: null,
    uptime: 0,
    message: '未连接',
  });

  // macOS 提权密码模态框状态
  const sudoVisible = ref(false);
  const sudoPasswordInput = ref('');
  const sudoVerifying = ref(false);
  const vpnToConnectAfterSudo = ref<'fortinet' | 'atrust' | 'both' | 'disconnectAll' | null>(null);

  // 二次认证 (MFA) 状态
  const mfaVisible = ref(false);
  const mfaPrompt = ref('');
  const mfaCodeInput = ref('');
  const mfaVerifying = ref(false);

  // 图形验证码 (Captcha) 状态
  const captchaVisible = ref(false);
  const captchaUrl = ref('');

  // 定时器
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let uptimeInterval: ReturnType<typeof setInterval> | null = null;
  let stateFetchInFlight = false;

  // 监听广播状态改变
  let statusUnlisten: (() => void) | null = null;

  /** 查询两套 VPN 状态，并阻止定时器叠加未完成请求。 */
  const fetchVpnStates = async () => {
    if (stateFetchInFlight) return;
    stateFetchInFlight = true;
    try {
      const [fState, aState]: any[] = await Promise.all([
        invoke('get_vpn_state', { vpnType: 'Fortinet' }),
        invoke('get_vpn_state', { vpnType: 'Atrust' }),
      ]);
      fortinetState.value = {
        status: fState.status.toLowerCase() as any,
        virtualIp: fState.virtualIp,
        uptime: fState.uptime,
        message: fState.message,
      };

      atrustState.value = {
        status: aState.status.toLowerCase() as any,
        virtualIp: aState.virtualIp,
        uptime: aState.uptime,
        message: aState.message,
      };
    } catch (err) {
      console.error('Fetch VPN states error:', err);
    } finally {
      stateFetchInFlight = false;
    }
  };

  // 验证 Sudo 提权密码并暂存
  const submitSudoPassword = async () => {
    if (!sudoPasswordInput.value) {
      message.warning('Sudo 密码不能为空');
      return;
    }
    sudoVerifying.value = true;
    try {
      const success: boolean = await invoke('verify_sudo_password', {
        password: sudoPasswordInput.value,
      });
      if (success) {
        sudoVisible.value = false;
        message.success('macOS 提权验证成功');
        
        // 提权成功后，继续触发此前被拦截的连接请求
        const target = vpnToConnectAfterSudo.value;
        vpnToConnectAfterSudo.value = null;
        if (target === 'fortinet') {
          void doConnectFortinet();
        } else if (target === 'atrust') {
          void doConnectAtrust();
        } else if (target === 'both') {
          void doConnectBoth();
        } else if (target === 'disconnectAll') {
          void doDisconnectAll();
        }
      } else {
        message.error('Sudo 密码错误，提权失败');
      }
    } catch (err: any) {
      message.error(err?.toString() || '密码提权发生未知错误');
    } finally {
      sudoVerifying.value = false;
    }
  };

  // 执行 Fortinet 连接
  const doConnectFortinet = async () => {
    try {
      const settings: any = await invoke('load_vpn_config');
      const fConfig = settings.fortinet;
      
      fortinetState.value.status = 'connecting';
      fortinetState.value.message = '正在建立安全通道...';

      // 连接时需手输/提供密码，这里我们需要在 Settings 里存好或弹出，我们先从 load 获得
      // 由于 AppVpnSettings 在本地保存（这里第一期我们在界面提供密码项，若未存则警告）
      const pwd = fConfig.password || ''; 
      if (!pwd) {
        message.warning('请先在配置页面填写 Fortinet 密码');
        fortinetState.value.status = 'disconnected';
        fortinetState.value.message = '未连接';
        return;
      }

      // 获取系统 openfortivpn 的执行路径，默认为 /Users/wangyancong/Documents/源码/openfortivpn/openfortivpn
      const openfortivpnBin = '/Users/wangyancong/Documents/源码/openfortivpn/openfortivpn';

      await invoke('connect_fortinet', {
        openfortivpnBin,
        password: pwd,
        host: fConfig.host,
        port: fConfig.port,
        username: fConfig.username,
        customRoutes: fConfig.customRoutes || ['192.168.100.0/24'],
      });
      message.info('正在拉起 Fortinet VPN...');
    } catch (err: any) {
      message.error(`Fortinet 启动失败: ${err}`);
      fortinetState.value.status = 'error';
      fortinetState.value.message = err?.toString() || '启动出错';
    }
  };

  // 执行 aTrust 连接
  const doConnectAtrust = async () => {
    try {
      const settings: any = await invoke('load_vpn_config');
      const aConfig = settings.atrust;

      atrustState.value.status = 'connecting';
      atrustState.value.message = '正在建立安全通道...';

      const pwd = aConfig.password || '';
      if (!pwd) {
        message.warning('请先在配置页面填写 aTrust 密码');
        atrustState.value.status = 'disconnected';
        atrustState.value.message = '未连接';
        return;
      }

      // 默认 zju-connect 路径为 /Users/wangyancong/Documents/源码/openfortivpn-atrust/bin/zju-connect
      const zjuConnectBin = '/Users/wangyancong/Documents/源码/openfortivpn-atrust/bin/zju-connect';

      await invoke('connect_atrust', {
        zjuConnectBin,
        password: pwd,
      });
      message.info('正在拉起 aTrust VPN...');
    } catch (err: any) {
      message.error(`aTrust 启动失败: ${err}`);
      atrustState.value.status = 'error';
      atrustState.value.message = err?.toString() || '启动出错';
    }
  };

  // 触发 Fortinet 连接（前置检查 sudo）
  const toggleFortinet = async () => {
    if (fortinetState.value.status === 'connected' || fortinetState.value.status === 'connecting') {
      fortinetState.value.status = 'disconnecting';
      fortinetState.value.message = '正在断开...';
      try {
        await invoke('disconnect_fortinet');
        message.success('已发送断开 Fortinet 命令');
      } catch (err: any) {
        message.error(`断开失败: ${err}`);
      }
    } else {
      // 检查后端是否已有 sudo 密码
      const hasSudo = await checkSudoAvailability();
      if (!hasSudo) {
        vpnToConnectAfterSudo.value = 'fortinet';
        sudoPasswordInput.value = '';
        sudoVisible.value = true;
      } else {
        void doConnectFortinet();
      }
    }
  };

  // 触发 aTrust 连接（前置检查 sudo）
  const toggleAtrust = async () => {
    if (atrustState.value.status === 'connected' || atrustState.value.status === 'connecting') {
      atrustState.value.status = 'disconnecting';
      atrustState.value.message = '正在断开...';
      try {
        await invoke('disconnect_atrust');
        message.success('已发送断开 aTrust 命令');
      } catch (err: any) {
        message.error(`断开失败: ${err}`);
      }
    } else {
      const hasSudo = await checkSudoAvailability();
      if (!hasSudo) {
        vpnToConnectAfterSudo.value = 'atrust';
        sudoPasswordInput.value = '';
        sudoVisible.value = true;
      } else {
        void doConnectAtrust();
      }
    }
  };

  /** 检测当前 App 会话是否已经完成 sudo 提权验证。 */
  const checkSudoAvailability = async (): Promise<boolean> => {
    try {
      return await invoke<boolean>('has_sudo_credentials');
    } catch {
      return false;
    }
  };

  // 一键同时连接 Both
  const connectBoth = async () => {
    const hasSudo = await checkSudoAvailability();
    if (!hasSudo) {
      vpnToConnectAfterSudo.value = 'both';
      sudoPasswordInput.value = '';
      sudoVisible.value = true;
    } else {
      void doConnectBoth();
    }
  };

  const submitMfaCode = async () => {
    if (!mfaCodeInput.value) {
      message.warning('请输入验证码');
      return;
    }
    mfaVerifying.value = true;
    try {
      await invoke('submit_vpn_mfa', { code: mfaCodeInput.value });
      mfaVisible.value = false;
      message.success('验证码已成功提交给登录进程');
    } catch (err: any) {
      message.error(err?.toString() || '提交验证码失败');
    } finally {
      mfaVerifying.value = false;
    }
  };

  const doConnectBoth = async () => {
    message.loading({ content: '正在协同拉起双通道连接...', duration: 2 });
    void doConnectFortinet();
    // 延迟 1.2 秒启动 aTrust，避免 Sudo 并发冲突
    setTimeout(() => {
      void doConnectAtrust();
    }, 1200);
  };

  /** 并行执行两套 VPN 的后端清理命令。 */
  const doDisconnectAll = async () => {
    message.loading({ content: '正在切断所有连接...', duration: 2 });
    const results = await Promise.allSettled([
      invoke('disconnect_fortinet'),
      invoke('disconnect_atrust'),
    ]);
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
      message.warning(`已执行全断开，其中 ${failures.length} 个清理命令失败，请查看日志`);
      return;
    }
    message.success('全部 VPN 已断开');
  };

  /** 无条件清理两套 VPN；无会话提权凭据时先引导用户验证。 */
  const disconnectAll = async () => {
    const hasSudo = await checkSudoAvailability();
    if (!hasSudo) {
      vpnToConnectAfterSudo.value = 'disconnectAll';
      sudoPasswordInput.value = '';
      sudoVisible.value = true;
      return;
    }
    await doDisconnectAll();
  };

  let authUnlisten: (() => void) | null = null;

  onMounted(() => {
    void initLogListener();
    void fetchVpnStates();

    // 1. 定时状态拉取
    pollInterval = setInterval(fetchVpnStates, 3000);

    // 2. 状态更新广播监听
    listen('vpn-status-changed', (event: any) => {
      const p: any = event.payload;
      const cleanStatus = p.status.toLowerCase() as any;
      if (cleanStatus === 'connected' || cleanStatus === 'disconnected') {
        captchaVisible.value = false;
        captchaUrl.value = '';
      }

      if (p.vpn_type === 'Fortinet') {
        fortinetState.value = {
          status: cleanStatus,
          virtualIp: p.virtualIp,
          uptime: p.uptime,
          message: p.message,
        };
      } else {
        atrustState.value = {
          status: cleanStatus,
          virtualIp: p.virtualIp,
          uptime: p.uptime,
          message: p.message,
        };
      }
    }).then((unsub) => {
      statusUnlisten = unsub;
    });

    // 监听二次认证验证码提示
    listen('vpn-auth-required', (event: any) => {
      const p: any = event.payload;
      mfaPrompt.value = p.prompt || '请输入二次验证码';
      mfaCodeInput.value = '';
      mfaVisible.value = true;
    }).then((unsub) => {
      authUnlisten = unsub;
    });

    // 监听图形/滑动验证码 URL
    listen('vpn-captcha-required', (event: any) => {
      const p: any = event.payload;
      captchaUrl.value = p.url;
      captchaVisible.value = true;
    }).then((unsub) => {
      captchaUnlisten = unsub;
    });

    // 3. 前端时长计时累加器
    uptimeInterval = setInterval(() => {
      if (fortinetState.value.status === 'connected') {
        fortinetState.value.uptime += 1;
      }
      if (atrustState.value.status === 'connected') {
        atrustState.value.uptime += 1;
      }
    }, 1000);
  });

  let captchaUnlisten: (() => void) | null = null;

  onUnmounted(() => {
    if (pollInterval) clearInterval(pollInterval);
    if (uptimeInterval) clearInterval(uptimeInterval);
    if (statusUnlisten) statusUnlisten();
    if (authUnlisten) authUnlisten();
    if (captchaUnlisten) captchaUnlisten();
  });

  return {
    fortinetState,
    atrustState,
    sudoVisible,
    sudoPasswordInput,
    sudoVerifying,
    submitSudoPassword,
    toggleFortinet,
    toggleAtrust,
    connectBoth,
    disconnectAll,
    mfaVisible,
    mfaPrompt,
    mfaCodeInput,
    mfaVerifying,
    submitMfaCode,
    captchaVisible,
    captchaUrl,
  };
}
