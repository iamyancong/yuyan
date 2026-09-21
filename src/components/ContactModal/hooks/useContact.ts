import { ref } from 'vue';
import { message } from 'ant-design-vue';
import { openExternal } from '@/utils/open';
import { CONTACT_CONFIG, type ContactInfo } from '../constant';

/**
 * 联系我们业务逻辑 Hook
 * @description 处理企业微信客户端唤起、剪贴板数据复制、名片外部跳转等交互
 * @returns {object} 联系支持相关的响应式数据与操作方法
 */
export const useContact = () => {
  const contactInfo = ref<ContactInfo>(CONTACT_CONFIG);
  const isLaunching = ref(false);

  /**
   * 在电脑企业微信中一键联系
   * @description 自动复制联系人工作邮箱至剪贴板，并唤起电脑端已安装的企业微信应用
   * @returns {Promise<void>}
   */
  const handleContactViaWeCom = async (): Promise<void> => {
    isLaunching.value = true;
    try {
      // 1. 将邮箱复制到剪贴板（企微内部员工通过邮箱可直接准确定位好友）
      await navigator.clipboard.writeText(contactInfo.value.email);

      // 2. 尝试唤起本地企业微信客户端
      await openExternal(contactInfo.value.wecomScheme);

      message.success(
        `已复制邮箱【${contactInfo.value.email}】并唤起企微，直接在企微搜索框 ⌘V / Ctrl+V 粘贴即可联系！`,
        4
      );
    } catch (error) {
      console.error('唤起企微或复制邮箱失败:', error);
      // 降级提示手动复制
      message.info(`邮箱已复制: ${contactInfo.value.email}，请在企业微信中搜索联系`);
    } finally {
      setTimeout(() => {
        isLaunching.value = false;
      }, 600);
    }
  };

  /**
   * 在系统默认浏览器中打开企业微信网页名片
   * @returns {Promise<void>}
   */
  const handleOpenCardUrl = async (): Promise<void> => {
    if (!contactInfo.value.cardUrl) {
      message.info('当前未配置网页名片链接，请通过工作邮箱联系支持人员');
      return;
    }
    try {
      await openExternal(contactInfo.value.cardUrl);
    } catch (error) {
      console.error('打开名片链接失败:', error);
      message.error('打开企业微信名片链接失败');
    }
  };

  /**
   * 单独复制工作邮箱
   * @returns {Promise<void>}
   */
  const handleCopyEmail = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(contactInfo.value.email);
      message.success(`邮箱已成功复制: ${contactInfo.value.email}`);
    } catch (error) {
      console.error('复制邮箱失败:', error);
      message.error('复制邮箱失败，请手动选择复制');
    }
  };

  /**
   * 单独复制代码工号
   * @returns {Promise<void>}
   */
  const handleCopyWorkNo = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(contactInfo.value.workNo);
      message.success(`工号已成功复制: ${contactInfo.value.workNo}`);
    } catch (error) {
      console.error('复制工号失败:', error);
      message.error('复制工号失败，请手动选择复制');
    }
  };

  return {
    contactInfo,
    isLaunching,
    handleContactViaWeCom,
    handleOpenCardUrl,
    handleCopyEmail,
    handleCopyWorkNo,
  };
};
