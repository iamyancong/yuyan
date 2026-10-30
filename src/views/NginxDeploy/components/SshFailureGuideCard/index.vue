<script setup lang="ts">
import { computed } from 'vue';
import { ExclamationCircleFilled } from '@ant-design/icons-vue';
import { YButton } from '@yss-ui/components/lite';
import { getSshFailureGuide, type SshFailureAction, type SshFailureInfo } from '../../sshFailureGuide';

defineOptions({ name: 'SshFailureGuideCard' });

/** SSH 失败引导卡片属性 */
interface SshFailureGuideCardProps {
  /** 后端返回的 SSH 失败详情 */
  failure: SshFailureInfo;
  /** 只读模式：发布记录等场景只展示说明，不展示操作按钮 */
  readonly?: boolean;
}

const props = defineProps<SshFailureGuideCardProps>();
const emit = defineEmits<{ (e: 'action', action: SshFailureAction): void }>();

/** 引导内容 */
const guide = computed(() => getSshFailureGuide(props.failure));
</script>

<template>
  <section class="ssh-failure-guide" :class="`is-${guide.code}`" role="alert">
    <header class="ssh-failure-guide__header">
      <ExclamationCircleFilled class="ssh-failure-guide__icon" />
      <div class="ssh-failure-guide__heading">
        <strong>{{ guide.message }}</strong>
        <span v-if="failure.host">{{ failure.serverName || failure.host }} · {{ failure.host }}{{ failure.port ? `:${failure.port}` : '' }}</span>
      </div>
    </header>

    <div class="ssh-failure-guide__body">
      <div class="ssh-failure-guide__reasons">
        <span class="ssh-failure-guide__label">可能原因</span>
        <ul>
          <li v-for="reason in guide.reasons" :key="reason">{{ reason }}</li>
        </ul>
      </div>

      <p class="ssh-failure-guide__fix">{{ guide.fix }}</p>
      <p v-if="guide.hint" class="ssh-failure-guide__hint">{{ guide.hint }}</p>
    </div>

    <footer v-if="!readonly && guide.actions.length" class="ssh-failure-guide__actions">
      <YButton
        v-for="action in guide.actions"
        :key="action.key"
        size="small"
        :type="action.primary ? 'primary' : 'default'"
        @click="emit('action', action)"
      >
        {{ action.label }}
      </YButton>
    </footer>
  </section>
</template>

<style scoped lang="less">
@import './style.less';
</style>
