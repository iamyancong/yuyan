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

const selectedHashedSet = ref<Set<string>>(new Set());
const selectedOtherSet = ref<Set<string>>(new Set());
const ageDaysInput = ref(7);
const searchKeyword = ref('');
const hashedPage = ref(1);
const otherPage = ref(1);
const PAGE_SIZE = 50;

watch(() => props.minAgeDays, (val) => { ageDaysInput.value = Math.max(1, val || 1); }, { immediate: true });
watch(() => props.preview, (val) => {
  selectedHashedSet.value = new Set((val?.hashedCandidates || []).map((item) => item.relativePath));
  selectedOtherSet.value = new Set();
  searchKeyword.value = '';
  hashedPage.value = 1;
  otherPage.value = 1;
});
watch(searchKeyword, () => {
  hashedPage.value = 1;
  otherPage.value = 1;
});

const toggleHashedItem = (relPath: string, checked: boolean) => {
  const next = new Set(selectedHashedSet.value);
  if (checked) next.add(relPath);
  else next.delete(relPath);
  selectedHashedSet.value = next;
};

const toggleOtherItem = (relPath: string, checked: boolean) => {
  const next = new Set(selectedOtherSet.value);
  if (checked) next.add(relPath);
  else next.delete(relPath);
  selectedOtherSet.value = next;
};

const filteredHashed = computed(() => {
  const list = props.preview?.hashedCandidates || [];
  const kw = searchKeyword.value.trim().toLowerCase();
  if (!kw) return list;
  return list.filter((item) => item.relativePath.toLowerCase().includes(kw));
});
const pagedHashed = computed(() => {
  const start = (hashedPage.value - 1) * PAGE_SIZE;
  return filteredHashed.value.slice(start, start + PAGE_SIZE);
});
const filteredOther = computed(() => {
  const list = props.preview?.otherCandidates || [];
  const kw = searchKeyword.value.trim().toLowerCase();
  if (!kw) return list;
  return list.filter((item) => item.relativePath.toLowerCase().includes(kw));
});
const pagedOther = computed(() => {
  const start = (otherPage.value - 1) * PAGE_SIZE;
  return filteredOther.value.slice(start, start + PAGE_SIZE);
});

const selectedHashedCount = computed(() => selectedHashedSet.value.size);
const allSelected = computed(() => [...selectedHashedSet.value, ...selectedOtherSet.value]);
const selectedTotalBytes = computed(() => {
  const map = new Map<string, number>();
  for (const item of [...(props.preview?.hashedCandidates || []), ...(props.preview?.otherCandidates || [])]) {
    map.set(item.relativePath, item.sizeBytes);
  }
  return allSelected.value.reduce((sum, rel) => sum + (map.get(rel) || 0), 0);
});
const toggleAllHashed = (checked: boolean) => {
  selectedHashedSet.value = checked
    ? new Set((props.preview?.hashedCandidates || []).map((i) => i.relativePath))
    : new Set();
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
        <a-space wrap>
          <span>最小未修改天数（安全宽限 ≥ 1 天）：</span>
          <a-input-number v-model:value="ageDaysInput" :min="1" :max="365" :precision="0" size="small" />
          <YButton size="small" :disabled="loading || cleaning" @click="emit('reload', Math.max(1, ageDaysInput || 1))">重新扫描</YButton>
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
          :message="`已排除当前发布清单及所有存活备份引用。执行删除前会在目录锁内二次复核清单与修改时间，删除不可恢复。扫描目录：${preview.hashedAssetDirs.join('、')}`"
        />

        <div v-if="preview.hashedCandidates.length + preview.otherCandidates.length > 20" class="orphan-modal-search">
          <a-input-search
            v-model:value="searchKeyword"
            allow-clear
            size="small"
            placeholder="按文件路径筛选候选静态资源…"
          />
        </div>

        <div class="orphan-section">
          <div class="orphan-section__header">
            <a-checkbox
              :checked="selectedHashedCount > 0 && selectedHashedCount === preview.hashedCandidates.length"
              :indeterminate="selectedHashedCount > 0 && selectedHashedCount < preview.hashedCandidates.length"
              @change="(e: any) => toggleAllHashed(Boolean(e.target.checked))"
            >
              <strong>高置信度历史构建产物</strong>（{{ preview.hashedCandidates.length }} 个，共 {{ formatStorageBytes(preview.hashedCandidateBytes) }}）
            </a-checkbox>
          </div>
          <div v-if="filteredHashed.length" class="orphan-list">
            <div class="orphan-check-group">
              <div v-for="item in pagedHashed" :key="item.relativePath" class="orphan-list__row">
                <a-checkbox
                  :checked="selectedHashedSet.has(item.relativePath)"
                  @change="(e: any) => toggleHashedItem(item.relativePath, Boolean(e.target.checked))"
                >
                  <code>{{ item.relativePath }}</code>
                </a-checkbox>
                <span class="orphan-list__size">{{ formatStorageBytes(item.sizeBytes) }}</span>
              </div>
            </div>
            <div v-if="filteredHashed.length > PAGE_SIZE" class="orphan-list__pager">
              <a-pagination
                v-model:current="hashedPage"
                :total="filteredHashed.length"
                :page-size="PAGE_SIZE"
                :show-size-changer="false"
                size="small"
              />
            </div>
          </div>
          <a-empty v-else description="未发现超过宽限期的无主构建产物" :image-style="{ height: '36px' }" />
        </div>

        <div v-if="preview.otherCandidates.length" class="orphan-section">
          <div class="orphan-section__header">
            <strong>其他非清单文件（默认不勾选，请确认非人工放置文件）</strong>
            <span>（{{ preview.otherCandidates.length }} 个，共 {{ formatStorageBytes(preview.otherCandidateBytes) }}）</span>
          </div>
          <div v-if="filteredOther.length" class="orphan-list">
            <div class="orphan-check-group">
              <div v-for="item in pagedOther" :key="item.relativePath" class="orphan-list__row">
                <a-checkbox
                  :checked="selectedOtherSet.has(item.relativePath)"
                  @change="(e: any) => toggleOtherItem(item.relativePath, Boolean(e.target.checked))"
                >
                  <code>{{ item.relativePath }}</code>
                </a-checkbox>
                <span class="orphan-list__size">{{ formatStorageBytes(item.sizeBytes) }}</span>
              </div>
            </div>
            <div v-if="filteredOther.length > PAGE_SIZE" class="orphan-list__pager">
              <a-pagination
                v-model:current="otherPage"
                :total="filteredOther.length"
                :page-size="PAGE_SIZE"
                :show-size-changer="false"
                size="small"
              />
            </div>
          </div>
        </div>
      </template>
    </a-spin>

    <template #footer>
      <div class="orphan-modal-footer">
        <span>已选 <strong>{{ allSelected.length }}</strong> 个文件，预计释放 <strong>{{ formatStorageBytes(selectedTotalBytes) }}</strong>（删除不可恢复）</span>
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
