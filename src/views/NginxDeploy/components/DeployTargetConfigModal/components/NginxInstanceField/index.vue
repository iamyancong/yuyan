<script setup lang="ts">
import { computed } from 'vue';
import message from 'ant-design-vue/es/message';
import { copyToClipboard } from '@yss-ui/utils';
import {
  ArrowDownOutlined,
  CopyOutlined,
  HddOutlined,
  InfoCircleOutlined,
  LinkOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons-vue';
import type { DeployServer, NginxInstance } from '@/api/deploy';
import { buildNginxInstanceOptions, formatPathForDisplay, resolveBindingPreviewInfo } from './constant';

defineOptions({ name: 'NginxInstanceField' });

/** Nginx 实例选择器字段属性 */
interface NginxInstanceFieldProps {
  /** 当前选中的实例 ID */
  modelValue?: number;
  /** 关联服务器对象 */
  server?: DeployServer | null;
  /** 关联实例对象 */
  instance?: NginxInstance | null;
  /** 是否禁用 */
  disabled?: boolean;
  /** 部署根目录 */
  deployRoot?: string;
  /** 域名 */
  domain?: string;
  /** 端口 */
  port?: number | string;
}

const props = defineProps<NginxInstanceFieldProps>();
const emit = defineEmits<{
  'update:modelValue': [value: number | undefined];
}>();

/** 动态计算当前服务器下的可见实例下拉项 */
const options = computed(() => buildNginxInstanceOptions(props.server));

/** 占位提示语 */
const placeholder = computed(() => {
  if (!props.server) return '请先选择部署服务器';
  if (options.value.length === 0) return '该服务器暂无可用 Nginx 实例';
  return '请选择 Nginx 实例';
});

/** 气泡卡片所需的数据快照 */
const preview = computed(() =>
  resolveBindingPreviewInfo(
    props.server,
    props.instance,
    props.domain,
    props.port,
    props.deployRoot
  )
);

/** 气泡内路径的紧凑展示值，保留首尾目录便于识别。 */
const displayPaths = computed(() => ({
  defaultRoot: formatPathForDisplay(preview.value.defaultRoot),
  confPath: formatPathForDisplay(preview.value.confPath),
}));

/**
 * 复制气泡内的完整路径。
 * @param value 待复制的路径
 */
const copyPath = async (value: string) => {
  const text = value.trim();
  if (!text || text === '—') {
    message.warning('暂无可复制的路径');
    return;
  }

  const copied = await copyToClipboard(text);
  if (copied) {
    message.success('路径已复制到剪贴板');
    return;
  }
  message.error('路径复制失败，请检查剪贴板权限');
};

/** 选择变化处理 */
const handleChange = (val: unknown) => {
  emit('update:modelValue', val !== undefined && val !== null ? Number(val) : undefined);
};
</script>

<template>
  <div class="nginx-instance-field">
    <a-select
      :value="modelValue || undefined"
      :disabled="disabled || !server || options.length === 0"
      :placeholder="placeholder"
      show-search
      allow-clear
      option-filter-prop="searchKey"
      option-label-prop="title"
      :dropdown-match-select-width="false"
      popup-class-name="nginx-instance-select-dropdown"
      class="instance-select"
      @change="handleChange"
    >
      <a-select-option
        v-for="item in options"
        :key="item.value"
        :value="item.value"
        :title="item.title"
        :search-key="item.searchKey"
      >
        <div class="instance-select-option">
          <div class="option-header">
            <span class="option-name">{{ item.title }}</span>
            <a-tag :color="item.typeColor" class="option-tag">{{ item.typeLabel }}</a-tag>
          </div>
          <div class="option-desc">
            <span class="status-dot" :style="{ backgroundColor: item.statusColor }" />
            <span>{{ item.description }}</span>
          </div>
        </div>
      </a-select-option>
    </a-select>

    <!-- 右侧悬浮查看绑定详情气泡卡片 -->
    <a-popover
      v-if="server && instance && preview.isComplete"
      placement="bottomRight"
      trigger="hover"
      :arrow-point-at-center="true"
      overlay-class-name="nginx-binding-popover-card"
      :overlay-style="{ width: 'min(420px, calc(100vw - 32px))' }"
    >
      <template #content>
        <div class="binding-popover-card">
          <div class="popover-card__header">
            <div class="header-title">
              <LinkOutlined class="icon" />
              <span>Nginx 绑定详情</span>
            </div>
            <div class="header-extra">
              <a-tag :color="preview.instanceTypeColor">{{ preview.instanceTypeLabel }}</a-tag>
              <span class="status-pill">
                <span class="status-dot" :style="{ backgroundColor: preview.statusColor }" />
                {{ preview.statusLabel }}
              </span>
            </div>
          </div>

          <div class="popover-card__topology">
            <div class="node-box">
              <HddOutlined class="box-icon" />
              <div class="box-content">
                <div class="box-name">{{ preview.serverName }}</div>
                <div class="box-sub">{{ preview.serverHost || '当前服务器' }}</div>
              </div>
            </div>

            <div class="flow-arrow-box">
              <span class="arrow-text">{{ preview.instanceTypeLabel }}</span>
              <ArrowDownOutlined class="arrow-icon" />
            </div>

            <div class="node-box is-instance">
              <ThunderboltOutlined class="box-icon" />
              <div class="box-content">
                <div class="box-name">{{ preview.instanceName }}</div>
                <div class="box-sub">{{ preview.instanceVersion || '标准配置' }}</div>
              </div>
            </div>
          </div>

          <div class="popover-card__rows">
            <div class="meta-row">
              <span class="row-label">默认根目录</span>
              <div class="row-value-wrap">
                <a-tooltip
                  :title="preview.defaultRoot"
                  placement="topLeft"
                  overlay-class-name="nginx-binding-path-tooltip"
                >
                  <span class="row-value-preview">
                    <code class="row-val">{{ displayPaths.defaultRoot }}</code>
                  </span>
                </a-tooltip>
                <a-tooltip title="复制完整路径">
                  <button
                    type="button"
                    class="row-copy"
                    aria-label="复制默认根目录"
                    :disabled="preview.defaultRoot === '—'"
                    @click="copyPath(preview.defaultRoot)"
                  >
                    <CopyOutlined />
                  </button>
                </a-tooltip>
              </div>
            </div>
            <div class="meta-row">
              <span class="row-label">配置文件</span>
              <div class="row-value-wrap">
                <a-tooltip
                  :title="preview.confPath"
                  placement="topLeft"
                  overlay-class-name="nginx-binding-path-tooltip"
                >
                  <span class="row-value-preview">
                    <code class="row-val">{{ displayPaths.confPath }}</code>
                  </span>
                </a-tooltip>
                <a-tooltip title="复制完整路径">
                  <button
                    type="button"
                    class="row-copy"
                    aria-label="复制配置文件路径"
                    :disabled="preview.confPath === '—'"
                    @click="copyPath(preview.confPath)"
                  >
                    <CopyOutlined />
                  </button>
                </a-tooltip>
              </div>
            </div>
          </div>

          <div class="popover-card__footer">
            <InfoCircleOutlined class="footer-icon" />
            <span>{{ preview.tooltipText }}</span>
          </div>
        </div>
      </template>

      <div class="binding-badge-trigger" :class="preview.instanceType" title="悬浮查看绑定拓扑与配置">
        <LinkOutlined class="trigger-icon" />
        <span class="trigger-dot" :style="{ backgroundColor: preview.statusColor }" />
      </div>
    </a-popover>
  </div>
</template>

<style scoped lang="less">
@import './style.less';
</style>

<style lang="less">
@import './popup.less';
</style>
