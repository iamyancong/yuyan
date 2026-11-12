import { computed, onScopeDispose, ref, watch } from 'vue';
import message from 'ant-design-vue/es/message';
import { readNginxConf, type NginxConfSaveOptions, type NginxConfSaveResult } from '@/api/deploy';
import { getErrorMessage, normalizeNginxContent } from '../constant';
import { describeSaveFailure } from '../historyPolicy';
import { formatShortNginxErrorMessage, parseNginxError } from '../utils/nginxErrorParser';

/** 保存冲突（409 NGINX_CONF_CHANGED）时后端返回的线上最新内容 */
export interface NginxConfConflictDetails {
  path: string;
  currentContent: string;
  currentSha256: string;
  exists?: boolean;
}

/** 保存完成回调：error 为空表示成功，result 为保存结果 */
export type NginxConfSaveDone = (error?: unknown, result?: NginxConfSaveResult) => void;

/** 配置抽屉 save 事件签名 */
export type NginxConfSaveEmit = (
  e: 'save',
  targetId: number,
  content: string,
  done: NginxConfSaveDone,
  previousContent?: string,
  options?: NginxConfSaveOptions
) => void;

/**
 * Nginx 配置文件读取与保存逻辑 Hook
 * @param props 组件属性
 * @param emit 组件事件
 * @param callbacks 可选的生命周期与保存回调
 */
export function useNginxConfig(
  props: { targetId: number | null; readonly?: boolean },
  emit: {
    (e: 'update:targetId', value: number | null): void;
  } & NginxConfSaveEmit,
  callbacks?: {
    onSaveError?: (error: unknown) => void;
    onSaveSuccess?: () => void;
    onReset?: () => void;
    onConflict?: (details: NginxConfConflictDetails) => void;
  }
) {
  const loading = ref(false);
  const saving = ref(false);
  const configPath = ref('');
  const content = ref('');
  const originalContent = ref('');
  /** 线上基线内容摘要（打开或刷新基线时由后端返回），保存时作为乐观锁 */
  const baselineSha256 = ref('');
  /** 线上内容不是合法 UTF-8 */
  const encodingWarning = ref(false);
  /** 从历史版本恢复时记录的备份文件名与描述 */
  const restoredFrom = ref('');
  const restoredLabel = ref('');
  let loadGeneration = 0;

  /** 配置原始文本是否有变动（用于开关展示与关闭拦截） */
  const isRawDirty = computed(() => content.value !== originalContent.value);

  /** 语义级实质变动（消除换行与行尾空白后的实质差异） */
  const isSemanticDirty = computed(() => {
    if (!isRawDirty.value) return false;
    return normalizeNginxContent(content.value) !== normalizeNginxContent(originalContent.value);
  });

  /** 是否允许保存（必须存在实质变更、非保存中、非只读角色） */
  const canSave = computed(() => isRawDirty.value && isSemanticDirty.value && !saving.value && !props.readonly);

  /** 清除历史恢复标记 */
  const clearRestoreMark = () => {
    restoredFrom.value = '';
    restoredLabel.value = '';
  };

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
      baselineSha256.value = result.sha256 || '';
      encodingWarning.value = Boolean(result.encodingWarning);
      clearRestoreMark();
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
    baselineSha256.value = '';
    encodingWarning.value = false;
    clearRestoreMark();
    callbacks?.onReset?.();
  };

  /** 放弃未保存的修改，恢复到基线内容 */
  const discardChanges = () => {
    content.value = originalContent.value;
    clearRestoreMark();
    callbacks?.onReset?.();
  };

  /**
   * 用最新线上内容刷新基线（不改动编辑器内容）。
   * @param latestContent 线上最新内容
   * @param latestSha256 线上最新摘要
   * @returns 基线是否发生了变化
   */
  const refreshBaseline = (latestContent: string, latestSha256: string) => {
    const changed = latestContent !== originalContent.value;
    originalContent.value = latestContent;
    baselineSha256.value = latestSha256 || '';
    return changed;
  };

  /**
   * 把历史版本载入编辑器：基线同时刷新为刚读取的线上内容，之后走正常保存流程。
   * @param historyContent 历史版本内容
   * @param latest 刚读取的线上内容
   * @param source 历史版本文件名与描述
   * @returns 线上内容相对打开时是否已被修改
   */
  const applyRestore = (
    historyContent: string,
    latest: { content: string; sha256: string },
    source: { name: string; label: string }
  ) => {
    const baselineChanged = refreshBaseline(latest.content, latest.sha256);
    content.value = historyContent;
    restoredFrom.value = source.name;
    restoredLabel.value = source.label;
    callbacks?.onReset?.();
    return baselineChanged;
  };

  /** 保存并重载配置 */
  const handleSave = async () => {
    if (!props.targetId || !canSave.value) return;
    saving.value = true;
    const savingContent = content.value;
    try {
      const result = await new Promise<NginxConfSaveResult | undefined>((resolve, reject) => {
        // 第 4 个参数带上保存前的基线内容，外层据此判断 listen 端口是否在这次保存里被改动
        emit(
          'save',
          props.targetId as number,
          savingContent,
          (error?: unknown, saveResult?: NginxConfSaveResult) => {
            if (error) reject(error);
            else resolve(saveResult);
          },
          originalContent.value,
          {
            ...(baselineSha256.value ? { expectedSha256: baselineSha256.value } : {}),
            ...(restoredFrom.value ? { restoredFrom: restoredFrom.value } : {}),
          }
        );
      });
      originalContent.value = savingContent;
      baselineSha256.value = result?.sha256 || '';
      clearRestoreMark();
      callbacks?.onSaveSuccess?.();
    } catch (error: any) {
      const failure = describeSaveFailure(error);
      if (failure.kind === 'conflict') {
        const details = error?.response?.data?.details as NginxConfConflictDetails | undefined;
        if (details && typeof details.currentContent === 'string') {
          callbacks?.onConflict?.(details);
          message.warning('线上配置已被他人修改，请先查看差异');
        } else {
          message.error(getErrorMessage(error));
        }
        return;
      }
      callbacks?.onSaveError?.(error);
      const parsed = parseNginxError(error);
      if (failure.kind === 'rollback-failed') {
        message.error(failure.headline);
      } else if (failure.kind === 'reload') {
        message.error('Nginx 重载失败，已自动回滚到原配置');
      } else if (parsed.isNginxError) {
        message.error(formatShortNginxErrorMessage(parsed));
      } else {
        message.error(getErrorMessage(error));
      }
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

  // 编辑器内容回到基线时，历史恢复标记失效
  watch(isRawDirty, (dirty) => {
    if (!dirty) clearRestoreMark();
  });

  onScopeDispose(() => {
    loadGeneration += 1;
  });

  return {
    loading,
    saving,
    configPath,
    content,
    originalContent,
    baselineSha256,
    encodingWarning,
    restoredFrom,
    restoredLabel,
    isRawDirty,
    isSemanticDirty,
    canSave,
    loadConfig,
    resetConfig,
    discardChanges,
    refreshBaseline,
    applyRestore,
    handleSave,
  };
}
