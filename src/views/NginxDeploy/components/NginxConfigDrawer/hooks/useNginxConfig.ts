import { computed, onScopeDispose, ref, watch } from 'vue';
import message from 'ant-design-vue/es/message';
import { readNginxConf } from '@/api/deploy';
import { getErrorMessage } from '../constant';

/**
 * Nginx 配置文件管理逻辑 Hook
 * @param props 组件属性
 * @param emit 组件事件
 */
export function useNginxConfig(
  props: { targetId: number | null },
  emit: {
    (e: 'update:targetId', value: number | null): void;
    (e: 'save', targetId: number, content: string, done: (error?: unknown) => void): void;
  }
) {
  const loading = ref(false);
  const saving = ref(false);
  const configPath = ref('');
  const content = ref('');
  const originalContent = ref('');
  let loadGeneration = 0;

  /** 配置内容是否有修改 */
  const isDirty = computed(() => content.value !== originalContent.value);

  /** 底部操作提示文案 */
  const actionTip = computed(() => {
    if (!isDirty.value) return '当前配置未修改';
    return '配置已修改，保存并重载时将自动执行远程 Nginx 语法校验';
  });

  /** 加载 Nginx 配置文件 */
  const loadConfig = async () => {
    const targetId = props.targetId;
    if (!targetId) return;
    const currentGeneration = ++loadGeneration;
    loading.value = true;
    try {
      const result = await readNginxConf(targetId);
      if (currentGeneration !== loadGeneration || props.targetId !== targetId) return;
      configPath.value = result.path;
      content.value = result.content;
      originalContent.value = result.content;
    } catch (error: any) {
      if (currentGeneration !== loadGeneration || props.targetId !== targetId) return;
      message.error(error?.response?.data?.error || error?.message || '读取 Nginx 配置文件失败');
    } finally {
      if (currentGeneration === loadGeneration) loading.value = false;
    }
  };

  /** 清空当前配置并使未完成的读取请求失效 */
  const resetConfig = () => {
    loadGeneration += 1;
    loading.value = false;
    configPath.value = '';
    content.value = '';
    originalContent.value = '';
  };

  /** 保存配置 */
  const handleSave = async () => {
    if (!props.targetId || !isDirty.value) return;
    saving.value = true;
    try {
      await new Promise<void>((resolve, reject) => {
        emit('save', props.targetId as number, content.value, (error?: unknown) => {
          if (error) reject(error);
          else resolve();
        });
      });
      originalContent.value = content.value;
    } catch (error: any) {
      message.error(getErrorMessage(error));
    } finally {
      saving.value = false;
    }
  };

  watch(
    () => props.targetId,
    (id) => {
      if (id) void loadConfig();
      else resetConfig();
    },
    { immediate: true }
  );

  onScopeDispose(() => {
    loadGeneration += 1;
  });

  return {
    loading,
    saving,
    configPath,
    content,
    isDirty,
    actionTip,
    loadConfig,
    handleSave,
  };
}
