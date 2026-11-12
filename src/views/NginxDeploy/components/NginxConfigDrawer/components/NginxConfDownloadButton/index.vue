<script setup lang="ts">
import { computed } from 'vue';
import { DownloadOutlined } from '@ant-design/icons-vue';
import { buildEditingFileName, resolveConfigFileName } from '../../historyPolicy';
import { downloadTextFile } from '../../utils/downloadText';

defineOptions({ name: 'NginxConfDownloadButton' });

/** 配置下载按钮属性 */
interface Props {
  /** 配置文件路径（决定下载文件名） */
  configPath: string;
  /** 线上版内容（打开或保存后的基线） */
  onlineContent: string;
  /** 编辑中的内容 */
  editingContent: string;
  /** 是否有未保存修改 */
  dirty: boolean;
  /** 禁用 */
  disabled?: boolean;
}

const props = defineProps<Props>();

/** 线上版文件名，如 nginx.conf */
const onlineFileName = computed(() => resolveConfigFileName(props.configPath));
/** 编辑中文件名，如 nginx.editing.conf */
const editingFileName = computed(() => buildEditingFileName(onlineFileName.value));

/** 下载线上版 */
const downloadOnline = () => downloadTextFile(props.onlineContent, onlineFileName.value);
/** 下载编辑中版本 */
const downloadEditing = () => downloadTextFile(props.editingContent, editingFileName.value);

/** 下拉菜单点击 */
const handleMenuClick = ({ key }: { key: string | number }) => {
  if (key === 'editing') downloadEditing();
  else downloadOnline();
};
</script>

<template>
  <a-dropdown v-if="dirty" :trigger="['click']" placement="bottomRight" :disabled="disabled">
    <a-tooltip title="下载配置" placement="top">
      <button type="button" class="action-icon-btn" :disabled="disabled" aria-label="下载配置">
        <DownloadOutlined />
      </button>
    </a-tooltip>
    <template #overlay>
      <a-menu class="nginx-conf-download-menu" @click="handleMenuClick">
        <a-menu-item key="online">
          <div class="download-menu-item">
            <span class="item-title">下载线上版</span>
            <span class="item-desc">{{ onlineFileName }} · 服务器当前内容</span>
          </div>
        </a-menu-item>
        <a-menu-item key="editing">
          <div class="download-menu-item">
            <span class="item-title">下载编辑中</span>
            <span class="item-desc">{{ editingFileName }} · 含未保存修改</span>
          </div>
        </a-menu-item>
      </a-menu>
    </template>
  </a-dropdown>
  <a-tooltip v-else :title="`下载配置（${onlineFileName}）`" placement="top">
    <button type="button" class="action-icon-btn" :disabled="disabled" aria-label="下载配置" @click="downloadOnline">
      <DownloadOutlined />
    </button>
  </a-tooltip>
</template>

<style scoped lang="less">
.action-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: rgba(255, 255, 255, 0.65);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;

  &:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
}

.download-menu-item {
  display: flex;
  flex-direction: column;
  line-height: 1.5;
  padding: 2px 0;

  .item-title {
    font-weight: 500;
  }

  .item-desc {
    font-size: 12px;
    color: var(--text-color-secondary, #8c8c8c);
    font-family: var(--font-family-code, monospace);
  }
}
</style>
