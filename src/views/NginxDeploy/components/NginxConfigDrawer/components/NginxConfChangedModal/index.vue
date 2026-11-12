<script setup lang="ts">
import { computed, createVNode, ref, toRef, watch } from 'vue';
import { Modal } from 'ant-design-vue';
import { ExclamationCircleOutlined } from '@ant-design/icons-vue';
import { YMonacoDiff } from 'virtual:yss-heavy-components';
import NginxDiffToolbar from '../NginxDiffToolbar/index.vue';
import { CONFLICT_DIFF_MONACO_OPTIONS } from '../../../NginxConflictDiffModal/constant';
import { useNginxDiff } from '../../hooks/useNginxDiff';

defineOptions({ name: 'NginxConfChangedModal' });

/** 保存冲突（线上已被他人修改）弹窗属性 */
interface Props {
  /** 是否可见 */
  open: boolean;
  /** 配置文件路径 */
  path: string;
  /** 线上最新内容 */
  latestContent: string;
  /** 我准备保存的内容 */
  myContent: string;
  /** 覆盖保存进行中 */
  loading?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'keep-editing'): void;
  (e: 'overwrite'): void;
}>();

const latestRef = toRef(props, 'latestContent');
const myRef = toRef(props, 'myContent');
const alwaysDirty = ref(true);
const { diffMode, diffSummary, currentChangeIndex, totalChanges, bindDiffEditor, handleNextDiff, handlePrevDiff, resetDiffState } =
  useNginxDiff(myRef, latestRef, alwaysDirty, alwaysDirty);
diffMode.value = true;

const visible = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
});

/** 覆盖保存前二次确认：会用编辑器内容替换线上他人改动 */
const handleOverwrite = () => {
  Modal.confirm({
    title: '确认覆盖线上配置？',
    icon: createVNode(ExclamationCircleOutlined),
    content: '线上文件中他人的改动将被你的内容替换（覆盖前会自动生成 .bak 备份），保存后会执行 nginx -t 并重载。',
    okText: '确认覆盖',
    okType: 'danger',
    cancelText: '再看看',
    onOk: () => emit('overwrite'),
  });
};

watch(
  () => props.open,
  (open) => {
    if (!open) resetDiffState();
    else diffMode.value = true;
  }
);
</script>

<template>
  <a-modal
    v-model:open="visible"
    title="线上 Nginx 配置已被他人修改"
    width="1000px"
    class="nginx-conflict-diff-modal"
    :footer="null"
    destroy-on-close
    :mask-closable="false"
  >
    <a-alert type="warning" show-icon class="conflict-alert">
      <template #icon><ExclamationCircleOutlined /></template>
      <template #message>
        <div>
          <span>你打开配置之后，服务器上的文件被其他人或其他程序改过。平台没有覆盖，请核对差异后再决定。</span>
          <div v-if="path" class="conflict-path">目标文件：{{ path }}</div>
        </div>
      </template>
    </a-alert>

    <div class="conflict-editor-shell">
      <NginxDiffToolbar
        :is-dirty="true"
        :diff-mode="diffMode"
        :diff-summary="diffSummary"
        :current-change-index="currentChangeIndex"
        :total-changes="totalChanges"
        :content="myContent"
        @next-diff="handleNextDiff"
        @prev-diff="handlePrevDiff"
      />
      <div class="conflict-editor-header">
        <span class="side-title side-title--current">◀ 线上最新（刚刚读取）</span>
        <span class="side-title side-title--generated">我准备保存的内容 ▶</span>
      </div>
      <div class="conflict-editor-container">
        <YMonacoDiff
          :ref="bindDiffEditor"
          :original="latestContent"
          :value="myContent"
          language="nginx"
          theme="vs-dark"
          height="460px"
          :format-on-mount="false"
          :toolbar-tooltip="false"
          :toolbar-options="{ copy: false, fullscreen: false }"
          :options="CONFLICT_DIFF_MONACO_OPTIONS"
        />
      </div>
    </div>

    <div class="conflict-footer">
      <div class="footer-tip">「以线上为基线继续编辑」会保留你的修改，并把对比基线换成线上最新内容</div>
      <div class="footer-actions">
        <a-button danger :loading="loading" @click="handleOverwrite">仍然覆盖保存</a-button>
        <a-button type="primary" :disabled="loading" @click="emit('keep-editing')">以线上为基线继续编辑</a-button>
      </div>
    </div>
  </a-modal>
</template>

<style scoped lang="less">
@import '../../../NginxConflictDiffModal/style.less';
</style>
