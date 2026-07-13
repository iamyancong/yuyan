import { reactive, ref, watch, type Ref } from 'vue';
import message from 'ant-design-vue/es/message';
import {
  createDeployEnvironment,
  deleteDeployEnvironment,
  listDeployEnvironments,
  updateDeployEnvironment,
  type DeployEnvironment,
  type DeployEnvironmentPayload,
} from '@/api/deploy';
import { getErrorMessage } from '../../../utils';

/** 环境依赖 Hook 参数 */
interface UseBackendEnvironmentsParams {
  open: Ref<boolean>;
  selectedEnvironmentId: Ref<number>;
  onUpdated: () => void;
}

/** 创建空环境表单。 */
const createEmptyForm = (): DeployEnvironmentPayload => ({
  name: '',
  nacosServerAddr: '',
  nacosConsoleUrl: '',
  nacosNamespace: '',
  nacosGroup: 'DEFAULT_GROUP',
  username: '',
  password: '',
  token: '',
  gatewayPublicUrl: '',
});

/** 管理共享 Nacos/Gateway 环境配置。 */
export function useBackendEnvironments(params: UseBackendEnvironmentsParams) {
  const loading = ref(false);
  const saving = ref(false);
  const activeId = ref(0);
  const environments = ref<DeployEnvironment[]>([]);
  const form = reactive<DeployEnvironmentPayload>(createEmptyForm());
  let refreshSequence = 0;

  /**
   * 刷新环境列表。
   * @param fillSelected 是否将当前使用的环境同步到表单
   */
  const refresh = async (fillSelected = false) => {
    const currentSequence = ++refreshSequence;
    loading.value = true;
    try {
      const nextEnvironments = await listDeployEnvironments();
      if (currentSequence !== refreshSequence) return;
      environments.value = nextEnvironments;
      const selectedEnvironment = nextEnvironments.find(
        (environment) => environment.id === Number(params.selectedEnvironmentId.value || 0)
      );
      if (fillSelected && selectedEnvironment) editEnvironment(selectedEnvironment);
    } catch (error: any) {
      if (currentSequence !== refreshSequence) return;
      message.error(getErrorMessage(error));
    } finally {
      if (currentSequence === refreshSequence) loading.value = false;
    }
  };

  /** 重置为新增模式。 */
  const resetForm = () => {
    activeId.value = 0;
    Object.assign(form, createEmptyForm());
  };

  /** 编辑环境。 */
  const editEnvironment = (environment: DeployEnvironment) => {
    activeId.value = environment.id;
    Object.assign(form, {
      ...createEmptyForm(),
      name: environment.name,
      nacosServerAddr: environment.nacosServerAddr,
      nacosConsoleUrl: environment.nacosConsoleUrl,
      nacosNamespace: environment.nacosNamespace,
      nacosGroup: environment.nacosGroup,
      gatewayTargetId: environment.gatewayTargetId,
      gatewayPublicUrl: environment.gatewayPublicUrl,
    });
  };

  /** 保存环境。 */
  const saveEnvironment = async () => {
    if (!String(form.name || '').trim()) {
      message.warning('请填写环境名称');
      return;
    }
    saving.value = true;
    try {
      if (activeId.value) await updateDeployEnvironment(activeId.value, { ...form });
      else await createDeployEnvironment({ ...form });
      await refresh();
      params.onUpdated();
      resetForm();
      message.success('环境依赖配置已保存');
    } catch (error: any) {
      message.error(getErrorMessage(error));
    } finally {
      saving.value = false;
    }
  };

  /** 删除环境。 */
  const removeEnvironment = async (environment: DeployEnvironment) => {
    try {
      await deleteDeployEnvironment(environment.id);
      await refresh();
      params.onUpdated();
      if (activeId.value === environment.id) resetForm();
      message.success('环境依赖配置已删除');
    } catch (error: any) {
      message.error(getErrorMessage(error));
    }
  };

  watch([params.open, params.selectedEnvironmentId], ([open]) => {
    if (open) void refresh(true);
  }, { immediate: true });

  return { loading, saving, activeId, environments, form, refresh, resetForm, editEnvironment, saveEnvironment, removeEnvironment };
}
