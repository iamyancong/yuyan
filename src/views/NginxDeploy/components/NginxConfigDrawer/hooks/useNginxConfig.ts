import { computed, onScopeDispose, ref, watch } from 'vue';
import message from 'ant-design-vue/es/message';
import { readNginxConf } from '@/api/deploy';
import { getErrorMessage, normalizeNginxContent } from '../constant';

/**
 * Nginx 配置文件读取与保存逻辑 Hook
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

  /** 配置原始文本是否有变动（用于开关展示与关闭拦截） */
  const isRawDirty = computed(() => content.value !== originalContent.value);

  /** 语义级实质变动（消除换行与行尾空白后的实质差异） */
  const isSemanticDirty = computed(() => {
    if (!isRawDirty.value) return false;
    return normalizeNginxContent(content.value) !== normalizeNginxContent(originalContent.value);
  });

  /** 是否允许保存（必须存在实质变更且非保存中） */
  const canSave = computed(() => isRawDirty.value && isSemanticDirty.value && !saving.value);

  /** 加载远端 Nginx 配置文件 */
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

  /** 放弃未保存的修改，恢复到基线内容 */
  const discardChanges = () => {
    content.value = originalContent.value;
  };

  /** 保存并重载配置 */
  const handleSave = async () => {
    if (!props.targetId || !canSave.value) return;
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
    originalContent,
    isRawDirty,
    isSemanticDirty,
    canSave,
    loadConfig,
    resetConfig,
    discardChanges,
    handleSave,
  };
}
