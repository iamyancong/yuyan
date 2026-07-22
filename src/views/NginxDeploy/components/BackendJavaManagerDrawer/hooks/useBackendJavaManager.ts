import { reactive, ref, watch, type Ref } from 'vue';
import message from 'ant-design-vue/es/message';
import {
  createDeployJdk,
  createServerJavaRuntime,
  deleteServerJavaRuntime,
  deleteDeployJdk,
  listDeployJdks,
  listServerJavaRuntimes,
  scanServerJavaRuntimes,
  scanLocalDeployJdks,
  testDeployJdk,
  testServerJavaRuntime,
  type BuildJdk,
  type ServerJavaRuntime,
} from '@/api/deploy';
import { getErrorMessage } from '../../../utils';

/** Java 管理 Hook 参数 */
interface UseBackendJavaManagerParams {
  open: Ref<boolean>;
  serverId: Ref<number>;
  onUpdated: () => void;
}

/**
 * 管理本机构建 JDK 和服务器运行 JDK。
 * @param params 抽屉状态和更新回调
 * @returns Java 环境列表与操作方法
 */
export function useBackendJavaManager(params: UseBackendJavaManagerParams) {
  const loading = ref(false);
  const actionKey = ref('');
  const localJdks = ref<BuildJdk[]>([]);
  const serverRuntimes = ref<ServerJavaRuntime[]>([]);
  const localForm = reactive({ name: '', homePath: '' });
  const serverForm = reactive({ name: '', homePath: '' });
  let localScanCompleted = false;

  /** 加载当前 Java 环境列表。 */
  const refresh = async () => {
    if (!params.open.value) return;
    loading.value = true;
    try {
      const [localResult, remoteResult] = await Promise.allSettled([
        listDeployJdks(),
        params.serverId.value ? listServerJavaRuntimes(params.serverId.value) : Promise.resolve([]),
      ]);
      const errors: string[] = [];
      if (localResult.status === 'fulfilled') {
        localJdks.value = localResult.value;
      } else {
        errors.push(`本机构建 JDK 加载失败：${getErrorMessage(localResult.reason)}`);
      }
      if (remoteResult.status === 'fulfilled') {
        serverRuntimes.value = remoteResult.value;
      } else {
        serverRuntimes.value = [];
        errors.push(`服务器运行 JDK 加载失败：${getErrorMessage(remoteResult.reason)}`);
      }
      if (errors.length) message.error(errors.join('；'));
    } finally {
      loading.value = false;
    }
  };

  /** 新增本机构建 JDK。 */
  const addLocalJdk = async () => {
    if (!localForm.name.trim() || !localForm.homePath.trim()) {
      message.warning('请填写 JDK 名称和 JAVA_HOME');
      return;
    }
    actionKey.value = 'add-local';
    try {
      const created = await createDeployJdk({ name: localForm.name.trim(), homePath: localForm.homePath.trim() });
      await testDeployJdk(created.id);
      Object.assign(localForm, { name: '', homePath: '' });
      message.success('本机构建 JDK 已新增并检测');
    } catch (error: any) {
      message.error(getErrorMessage(error));
    } finally {
      await refresh();
      params.onUpdated();
      actionKey.value = '';
    }
  };

  /** 扫描 SDKMAN、jEnv、macOS JavaVirtualMachines 等本机 JDK。 */
  const scanLocalJdks = async (silent = false) => {
    actionKey.value = 'scan-local';
    try {
      localJdks.value = await scanLocalDeployJdks();
      params.onUpdated();
      const availableCount = localJdks.value.filter((jdk) => jdk.status === 'available').length;
      if (!silent) message.success(`扫描完成，发现 ${availableCount} 个可用构建 JDK`);
    } catch (error: any) {
      message.error(getErrorMessage(error));
    } finally {
      actionKey.value = '';
    }
  };

  /** 检测本机构建 JDK。 */
  const testLocalJdk = async (jdk: BuildJdk) => {
    actionKey.value = `local-${jdk.id}`;
    try {
      await testDeployJdk(jdk.id);
      await refresh();
      params.onUpdated();
      message.success('本机 JDK 检测完成');
    } catch (error: any) {
      message.error(getErrorMessage(error));
    } finally {
      actionKey.value = '';
    }
  };

  /** 删除本机构建 JDK。 */
  const deleteLocalJdk = async (jdk: BuildJdk) => {
    actionKey.value = `delete-local-${jdk.id}`;
    try {
      await deleteDeployJdk(jdk.id);
      await refresh();
      params.onUpdated();
      message.success('本机 JDK 已删除');
    } catch (error: any) {
      message.error(getErrorMessage(error));
    } finally {
      actionKey.value = '';
    }
  };

  /** 新增服务器运行 JDK。 */
  const addServerRuntime = async () => {
    if (!params.serverId.value) return;
    if (!serverForm.name.trim() || !serverForm.homePath.trim()) {
      message.warning('请填写运行时名称和服务器 JAVA_HOME');
      return;
    }
    actionKey.value = 'add-server';
    try {
      const created = await createServerJavaRuntime(params.serverId.value, {
        name: serverForm.name.trim(),
        homePath: serverForm.homePath.trim(),
      });
      await testServerJavaRuntime(created.id);
      Object.assign(serverForm, { name: '', homePath: '' });
      await refresh();
      message.success('服务器 Java 运行时已新增并检测');
    } catch (error: any) {
      message.error(getErrorMessage(error));
    } finally {
      actionKey.value = '';
    }
  };

  /** 扫描服务器常见 Java 安装路径。 */
  const scanServerRuntimes = async () => {
    if (!params.serverId.value) return;
    actionKey.value = 'scan-server';
    try {
      serverRuntimes.value = await scanServerJavaRuntimes(params.serverId.value);
      message.success(`扫描完成，发现 ${serverRuntimes.value.length} 个 Java 运行时`);
    } catch (error: any) {
      message.error(getErrorMessage(error));
    } finally {
      actionKey.value = '';
    }
  };

  /** 检测服务器 Java 运行时。 */
  const testServerRuntime = async (runtime: ServerJavaRuntime) => {
    actionKey.value = `server-${runtime.id}`;
    try {
      await testServerJavaRuntime(runtime.id);
      await refresh();
      message.success('服务器 Java 检测完成');
    } catch (error: any) {
      message.error(getErrorMessage(error));
    } finally {
      actionKey.value = '';
    }
  };

  /** 删除服务器 Java 运行时。 */
  const deleteServerRuntime = async (runtime: ServerJavaRuntime) => {
    actionKey.value = `delete-server-${runtime.id}`;
    try {
      await deleteServerJavaRuntime(runtime.id);
      await refresh();
      params.onUpdated();
      message.success('服务器 Java 运行时已删除');
    } catch (error: any) {
      message.error(getErrorMessage(error));
    } finally {
      actionKey.value = '';
    }
  };

  watch([params.open, params.serverId], ([open]) => {
    if (!open) return;
    void (async () => {
      await refresh();
      if (!localScanCompleted) {
        localScanCompleted = true;
        await scanLocalJdks(true);
      }
    })();
  }, { immediate: true });

  return {
    loading,
    actionKey,
    localJdks,
    serverRuntimes,
    localForm,
    serverForm,
    refresh,
    addLocalJdk,
    scanLocalJdks,
    testLocalJdk,
    deleteLocalJdk,
    addServerRuntime,
    scanServerRuntimes,
    testServerRuntime,
    deleteServerRuntime,
  };
}
