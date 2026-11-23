<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { YButton } from '@yss-ui/components/lite';
import type { OrphanAssetsPreviewResult } from '@/api/deploy';
import { formatStorageBytes } from '../constant';

defineOptions({ name: 'OrphanAssetsPreviewModal' });

/** 无主历史静态资源预览弹窗属性 */
interface OrphanAssetsPreviewModalProps {
  open: boolean;
  loading: boolean;
  cleaning: boolean;
  minAgeDays: number;
  preview: OrphanAssetsPreviewResult | null;
}

const props = defineProps<OrphanAssetsPreviewModalProps>();
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'reload', minAgeDays: number): void;
  (e: 'confirm', relativePaths: string[]): void;
}>();

const selectedHashed = ref<string[]>([]);
const selectedOther = ref<string[]>([]);
const ageDaysInput = ref(7);

watch(() => props.minAgeDays, (val) => { ageDaysInput.value = val; }, { immediate: true });
watch(() => props.preview, (val) => {
  selectedHashed.value = (val?.hashedCandidates || []).map((item) => item.relativePath);
  selectedOther.value = [];
});

const allSelected = computed(() => [...selectedHashed.value, ...selectedOther.value]);
const selectedTotalBytes = computed(() => {
  const map = new Map<string, number>();
  for (const item of [...(props.preview?.hashedCandidates || []), ...(props.preview?.otherCandidates || [])]) {
    map.set(item.relativePath, item.sizeBytes);
  }
  return allSelected.value.reduce((sum, rel) => sum + (map.get(rel) || 0), 0);
});
const toggleAllHashed = (checked: boolean) => {
  selectedHashed.value = checked ? (props.preview?.hashedCandidates || []).map((i) => i.relativePath) : [];
};
const handleConfirm = () => {
  if (allSelected.value.length) emit('confirm', allSelected.value);
};
</script>

<template>
  <a-modal
    :open="open"
    width="min(760px, 94vw)"
    :title="`无主历史静态资源扫描 · ${preview?.projectName || ''}`"
    :mask-closable="!cleaning"
    :closable="!cleaning"
    @cancel="emit('update:open', false)"
  >
    <a-spin :spinning="loading">
      <div class="orphan-modal-toolbar">
        <a-space>
          <span>最小未修改天数（安全宽限）：</span>
          <a-input-number v-model:value="ageDaysInput" :min="0" :max="365" size="small" />
          <YButton size="small" :disabled="loading || cleaning" @click="emit('reload', ageDaysInput)">重新扫描</YButton>
        </a-space>
        <span v-if="preview?.realRoot" class="orphan-modal-path">{{ preview.realRoot }}</span>
      </div>

      <a-alert
        v-if="preview && preview.status !== 'ok'"
        type="warning"
        show-icon
        :message="preview.reason"
        class="orphan-modal-alert"
      />

      <template v-else-if="preview">
        <a-alert
          type="info"
          show-icon
          class="orphan-modal-alert"
          :message="`已排除当前发布清单及所有存活备份引用的文件。扫描目录：${preview.hashedAssetDirs.join('、')}`"
        />

        <div class="orphan-section">
          <div class="orphan-section__header">
            <a-checkbox
              :checked="selectedHashed.length > 0 && selectedHashed.length === preview.hashedCandidates.length"
              :indeterminate="selectedHashed.length > 0 && selectedHashed.length < preview.hashedCandidates.length"
              @change="(e: any) => toggleAllHashed(Boolean(e.target.checked))"
            >
              <strong>高置信度历史构建产物</strong>（{{ preview.hashedCandidates.length }} 个，共 {{ formatStorageBytes(preview.hashedCandidateBytes) }}）
            </a-checkbox>
          </div>
          <div v-if="preview.hashedCandidates.length" class="orphan-list">
            <a-checkbox-group v-model:value="selectedHashed" class="orphan-check-group">
              <div v-for="item in preview.hashedCandidates.slice(0, 120)" :key="item.relativePath" class="orphan-list__row">
                <a-checkbox :value="item.relativePath">
                  <code>{{ item.relativePath }}</code>
                </a-checkbox>
                <span class="orphan-list__size">{{ formatStorageBytes(item.sizeBytes) }}</span>
              </div>
            </a-checkbox-group>
            <div v-if="preview.hashedCandidates.length > 120" class="orphan-list__more">
              仅展示体积最大的前 120 项，共选中 {{ selectedHashed.length }} 项
            </div>
          </div>
          <a-empty v-else description="未发现超过宽限期的无主构建产物" :image-style="{ height: '36px' }" />
        </div>

        <div v-if="preview.otherCandidates.length" class="orphan-section">
          <div class="orphan-section__header">
            <strong>其他非清单文件（默认不勾选，请确认非人工放置文件）</strong>
            <span>（{{ preview.otherCandidates.length }} 个，共 {{ formatStorageBytes(preview.otherCandidateBytes) }}）</span>
          </div>
          <div class="orphan-list">
            <a-checkbox-group v-model:value="selectedOther" class="orphan-check-group">
              <div v-for="item in preview.otherCandidates.slice(0, 80)" :key="item.relativePath" class="orphan-list__row">
                <a-checkbox :value="item.relativePath">
                  <code>{{ item.relativePath }}</code>
                </a-checkbox>
                <span class="orphan-list__size">{{ formatStorageBytes(item.sizeBytes) }}</span>
              </div>
            </a-checkbox-group>
          </div>
        </div>
      </template>
    </a-spin>

    <template #footer>
      <div class="orphan-modal-footer">
        <span>已选 <strong>{{ allSelected.length }}</strong> 个文件，预计释放 <strong>{{ formatStorageBytes(selectedTotalBytes) }}</strong></span>
        <a-space>
          <YButton :disabled="cleaning" @click="emit('update:open', false)">取消</YButton>
          <YButton type="primary" danger :loading="cleaning" :disabled="!allSelected.length" @click="handleConfirm">
            确认安全清理
          </YButton>
        </a-space>
      </div>
    </template>
  </a-modal>
</template>

<style scoped lang="less">
@import '../style.less';
</style>
