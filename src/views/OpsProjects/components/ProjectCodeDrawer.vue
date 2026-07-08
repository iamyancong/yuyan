<template>
  <a-drawer :open="open" title="项目代码浏览" placement="right" width="90%" @close="handleClose" class="project-code-drawer">
    <div class="drawer-container">
      <div class="info-section">
        <div style="margin-top: 12px">
          <span style="font-weight: bold">当前项目：</span>
          {{ projectName }}
        </div>
      </div>

      <div class="main-area">
        <!-- 左侧文件树 -->
        <div class="tree-panel">
          <div class="panel-header">
            <span>文件浏览</span>
            <a-button size="small" type="link" @click="refreshRoot" :loading="loading">刷新</a-button>
          </div>

          <div class="tree-content-wrapper" ref="treeWrapperRef">
            <div v-if="loading && treeData.length === 0" class="loading-state">
              <a-spin />
            </div>

            <a-directory-tree
              v-else
              v-model:checkedKeys="checkedKeys"
              :tree-data="treeData"
              :load-data="onLoadData"
              checkable
              @select="onSelect"
              class="file-tree"
              :height="treeHeight"
            />
          </div>
        </div>

        <!-- 右侧预览 -->
        <div class="preview-panel">
          <div class="panel-header">
            <span>文件预览: {{ previewTitle || '未选择文件' }}</span>
            <a-tag v-if="previewLoading">加载中...</a-tag>
          </div>
          <div class="code-viewer-wrapper">
            <YMonaco
              v-if="previewContent !== null"
              ref="monacoRef"
              v-model:modelValue="previewContent"
              :language="previewLanguage"
              theme="vs-dark"
              :options="{ readOnly: true, minimap: { enabled: false } }"
              class="code-viewer"
              height="100%"
            />
            <div v-else class="empty-preview">
              <span style="color: #999">点击文件名预览内容</span>
            </div>
          </div>
        </div>
      </div>

      <div class="footer-section">
        <div class="selected-info">已选 {{ checkedFileCount }} 个文件</div>
        <div>
          <a-button @click="handleClose">关闭</a-button>
        </div>
      </div>
    </div>
  </a-drawer>
</template>

<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted } from 'vue';
import { message } from 'ant-design-vue';
import { YMonaco } from '@yss-ui/components/lite';
import { getRepoTree, getFileContent, type RepoTreeItem } from '@/api/gitlab';

const props = defineProps<{
  open: boolean;
  projectId?: number;
  projectName?: string;
  defaultBranch?: string;
}>();

const emit = defineEmits(['update:open']);

const loading = ref(false);
const treeData = ref<any[]>([]);
const checkedKeys = ref<string[]>([]); // 选中的key (包含folder)
const loadedKeys = ref<Set<string>>(new Set()); // 已加载的目录

// 预览相关
const previewTitle = ref('');
const previewContent = ref<string | null>(null);
const previewLoading = ref(false);
const previewLanguage = ref('plaintext');
const monacoRef = ref();

// 树高度响应式
const treeWrapperRef = ref<HTMLDivElement | null>(null);
const treeHeight = ref(500);
let resizeObserver: ResizeObserver | null = null;

const updateTreeHeight = () => {
  if (treeWrapperRef.value) {
    treeHeight.value = treeWrapperRef.value.clientHeight;
  }
};

onMounted(() => {
  if (treeWrapperRef.value) {
    resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        updateTreeHeight();
      });
    });
    resizeObserver.observe(treeWrapperRef.value);
    updateTreeHeight();
  }
});

onUnmounted(() => {
  if (resizeObserver) {
    resizeObserver.disconnect();
  }
});

// 监听打开状态，加载根目录
watch(
  () => props.open,
  (val) => {
    if (val && props.projectId) {
      loadRoot();
    } else {
      // 重置状态
      treeData.value = [];
      checkedKeys.value = [];
      loadedKeys.value.clear();
      previewContent.value = null;
      previewTitle.value = '';
    }
  }
);

// 计算选中文件数
const checkedFileCount = computed(() => {
  return checkedKeys.value.length;
});

const handleClose = () => {
  emit('update:open', false);
};

const refreshRoot = () => {
  loadRoot();
};

// 加载根目录
const loadRoot = async () => {
  if (!props.projectId) return;

  loading.value = true;
  treeData.value = [];
  loadedKeys.value.clear();

  try {
    const items = await getRepoTree(
      props.projectId,
      '', // 根目录
      props.defaultBranch || 'dev',
      false // 非递归
    );

    treeData.value = convertToTreeNodes(items);
  } catch (error) {
    console.error('加载文件树失败:', error);
    message.error('加载文件树失败');
  } finally {
    loading.value = false;
  }
};

// 递归查找并更新节点
const updateTreeData = (list: any[], key: string, children: any[]): any[] => {
  return list.map((node) => {
    if (node.key === key) {
      return {
        ...node,
        children,
      };
    }
    if (node.children) {
      return {
        ...node,
        children: updateTreeData(node.children, key, children),
      };
    }
    return node;
  });
};

// 懒加载子目录
const onLoadData = (treeNode: any) => {
  return new Promise<void>(async (resolve) => {
    if (treeNode.children && treeNode.children.length > 0) {
      resolve();
      return;
    }

    if (!props.projectId) {
      resolve();
      return;
    }

    try {
      const folderPath = treeNode.eventKey;

      const items = await getRepoTree(
        props.projectId,
        folderPath,
        props.defaultBranch || 'dev',
        false // 非递归
      );

      const children = convertToTreeNodes(items);
      treeData.value = updateTreeData(treeData.value, folderPath, children);

      resolve();
    } catch (error) {
      console.error('加载子目录失败:', error);
      message.error('加载失败');
      resolve();
    }
  });
};

// 转换为 Ant Tree Node
const convertToTreeNodes = (items: RepoTreeItem[]) => {
  items.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'tree' ? -1 : 1;
  });

  return items.map((item) => ({
    title: item.name,
    key: item.path,
    isLeaf: item.type === 'blob',
  }));
};

const guessLanguage = (filename: string) => {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.vue')) return 'html';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
  if (lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.ets')) return 'typescript';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.less')) return 'less';
  if (lower.endsWith('.scss') || lower.endsWith('.sass')) return 'scss';
  if (lower.endsWith('.md')) return 'markdown';
  if (lower.endsWith('.xml')) return 'xml';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.sh') || lower.endsWith('.bash')) return 'shell';
  if (lower.endsWith('.sql')) return 'sql';
  if (lower.endsWith('.java')) return 'java';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.go')) return 'go';
  return 'plaintext';
};

// 选择文件预览
const onSelect = async (keys: string[], info: any) => {
  if (keys.length === 0) return;

  const node = info.node;
  if (!node.isLeaf) return;

  const filePath = node.key as string;
  const binaryExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.zip', '.tar', '.gz', '.pdf', '.woff', '.woff2', '.ttf'];
  if (binaryExtensions.some((ext) => filePath.toLowerCase().endsWith(ext))) {
    previewContent.value = '(不支持预览该文件类型)';
    previewTitle.value = filePath;
    return;
  }

  previewTitle.value = filePath;
  // 1. 设置语言
  const lang = guessLanguage(filePath);
  previewLanguage.value = lang;
  
  previewLoading.value = true;
  // 2. 清空当前内容，避免旧内容闪烁，同时触发 modelValue 更新
  previewContent.value = '';

  try {
    const { content } = await getFileContent(props.projectId!, filePath, props.defaultBranch || 'dev');
    previewContent.value = content;
    
    // 3. 强制设置语言（防止组件未响应 prop 变化）
    if (monacoRef.value?.setLanguage) {
      monacoRef.value.setLanguage(lang);
    }
  } catch (error) {
    console.error('预览失败:', error);
    previewContent.value = '预览失败，无法读取文件内容';
  } finally {
    previewLoading.value = false;
  }
};
</script>

<style scoped lang="less">
.project-code-drawer {
  .drawer-container {
    display: flex;
    flex-direction: column;
    height: 100%;

    .info-section {
      margin-bottom: 16px;
      flex-shrink: 0;
    }

    .main-area {
      flex: 1;
      display: flex;
      gap: 16px;
      min-height: 0;
      border: 1px solid var(--border-color-split);
      border-radius: 4px;
      background: var(--bg-color-container);

      .tree-panel {
        flex: 0 0 300px;
        border-right: 1px solid var(--border-color-split);
        display: flex;
        flex-direction: column;

        .file-tree {
          overflow-x: hidden;
        }
      }

      .tree-content-wrapper {
        flex: 1;
        min-height: 0;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      .preview-panel {
        flex: 1;
        display: flex;
        flex-direction: column;
        min-width: 0;

        .code-viewer-wrapper {
          flex: 1;
          position: relative;
          overflow: hidden;

          .code-viewer {
            height: 100%;
            width: 100%;
          }

          .empty-preview {
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            background: var(--bg-color-elevated);
          }
        }
      }

      .panel-header {
        padding: 8px 12px;
        border-bottom: 1px solid var(--border-color-split);
        background: var(--bg-color-elevated);
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-weight: 500;
        flex-shrink: 0;
      }

      .loading-state {
        padding: 20px;
        text-align: center;
      }
    }

    .footer-section {
      margin-top: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 16px;
      border-top: 1px solid var(--border-color-split);
      flex-shrink: 0;

      .selected-info {
        color: var(--text-color-secondary);
      }
    }
  }
}
</style>
