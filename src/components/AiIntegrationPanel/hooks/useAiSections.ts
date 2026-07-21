import { ref } from 'vue';
import { DEFAULT_EXPANDED_AI_SECTIONS, type AiSectionKey } from '../constant';

/** 管理 AI 控制中心折叠区域，避免轮询刷新影响展开状态。 */
export function useAiSections() {
  const expandedSections = ref<AiSectionKey[]>([...DEFAULT_EXPANDED_AI_SECTIONS]);

  /**
   * 判断区域是否展开。
   * @param key 区域标识
   * @returns 是否展开
   */
  const isSectionExpanded = (key: AiSectionKey) => expandedSections.value.includes(key);

  /**
   * 切换区域展开状态。
   * @param key 区域标识
   */
  const toggleSection = (key: AiSectionKey) => {
    expandedSections.value = isSectionExpanded(key)
      ? expandedSections.value.filter((item) => item !== key)
      : [...expandedSections.value, key];
  };

  return { expandedSections, isSectionExpanded, toggleSection };
}
