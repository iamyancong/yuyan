<script setup lang="ts">
import { CaretDownOutlined, CheckCircleOutlined, CloseOutlined, CopyOutlined, DownloadOutlined, ThunderboltOutlined } from '@ant-design/icons-vue';
import { useScaffoldProgressWorkbench, type ScaffoldProgressWorkbenchProps } from './hooks/useScaffoldProgressWorkbench';

const props = defineProps<ScaffoldProgressWorkbenchProps>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'goto-gitops'): void;
  (e: 'download'): void;
  (e: 'close'): void;
}>();

const {
  visible,
  statusText,
  statusTagColor,
  snapshot,
  showGitlabUrlFull,
  codeExpanded,
  modeText,
  isDownloadSuccessHero,
  isGitlabSuccessHero,
  isGitlabErrorHero,
  heroErrorSummary,
  showAccessSection,
  heroTitle,
  heroDescription,
  heroGitlabText,
  heroGitlabUrlShort,
  stageStatusLabel,
  copyText,
  openGitlab,
  handleClose,
} = useScaffoldProgressWorkbench(props, emit);
</script>

<template>
  <a-drawer
    v-model:open="visible"
    :width="920"
    placement="right"
    class="scaffold-progress-drawer"
    root-class-name="scaffold-progress-drawer"
    :closable="false"
    :maskClosable="!loading"
    :keyboard="!loading"
    destroyOnClose
    :bodyStyle="{ padding: '0', background: 'transparent' }"
    @close="handleClose"
  >
    <div class="workbench-shell" :class="[`status-${progress.status}`, { 'has-result': !!snapshot.downloadPath }]">
      <button class="shell-close" type="button" aria-label="关闭抽屉" :disabled="loading" @click="handleClose">
        <CloseOutlined />
      </button>

      <header
        class="hero-card"
        :class="{
          'hero-card--with-repo': isGitlabSuccessHero,
          'hero-card--compact': !isGitlabSuccessHero,
          'hero-card--download-success': isDownloadSuccessHero,
          'hero-card--error': progress.status === 'error',
          'hero-card--gitlab-error': isGitlabErrorHero,
        }"
      >
        <div class="hero-intro">
          <div class="eyebrow">实时进度</div>
          <h2>{{ heroTitle }}</h2>
          <p>{{ heroDescription }}</p>
          <div v-if="progress.status === 'error' && heroErrorSummary" class="hero-error-summary">
            {{ heroErrorSummary }}
          </div>
        </div>

        <div v-if="isGitlabSuccessHero" class="hero-repo">
          <span class="hero-repo-label">{{ heroGitlabText }}</span>
          <strong class="hero-repo-value">{{ heroGitlabUrlShort }}</strong>
        </div>

        <div class="hero-actions">
          <a-tag :color="statusTagColor" class="status-tag">{{ statusText }}</a-tag>
          <div class="hero-percent">{{ progress.percent }}%</div>
          <span class="hero-subtext">{{ modeText }}</span>
          <a-button v-if="isGitlabSuccessHero" class="hero-gitlab-btn" type="primary" @click="openGitlab">打开 GitLab</a-button>
        </div>
      </header>

      <div class="content-grid">
        <section class="panel timeline-panel">
          <div class="timeline-head">
            <div>
              <h3>创建步骤</h3>
              <p class="panel-subtext">{{ progress.currentStageTitle }} · {{ progress.currentMessage }}</p>
            </div>
            <div class="timeline-head-side">
              <span class="timeline-head-label">当前模式</span>
              <strong>{{ modeText }}</strong>
            </div>
          </div>

          <a-progress
            :percent="progress.percent"
            :show-info="false"
            :stroke-width="10"
            class="node-progress timeline-progress"
            :class="{ running: progress.status === 'running' }"
          />

          <div class="stage-rail" role="list" aria-label="创建步骤轨道">
            <article
              v-for="(stage, index) in progress.stages"
              :key="stage.key"
              class="stage-marker"
              :class="[`is-${stage.status}`, { active: stage.key === progress.currentStageKey }]"
              role="listitem"
            >
              <div class="stage-track">
                <span class="stage-node" :class="stage.status">
                  <CheckCircleOutlined v-if="stage.status === 'finish'" />
                  <ThunderboltOutlined v-else-if="stage.status === 'process'" />
                  <span v-else class="node-core" />
                </span>
                <span v-if="index < progress.stages.length - 1" class="stage-link" :class="stage.status" />
              </div>
              <div class="stage-marker-label">{{ stage.title }}</div>
            </article>
          </div>

          <div class="stage-card-grid" role="list" aria-label="创建步骤详情">
            <article
              v-for="(stage, index) in progress.stages"
              :key="`${stage.key}-card`"
              class="stage-item"
              :class="[`is-${stage.status}`, { active: stage.key === progress.currentStageKey }]"
              role="listitem"
            >
              <div class="stage-card" :class="stage.status">
                <div class="stage-card-top">
                  <span class="stage-index">{{ String(index + 1).padStart(2, '0') }}</span>
                  <span class="stage-badge" :class="`stage-badge--${stage.status}`">{{ stageStatusLabel(stage.status) }}</span>
                </div>

                <div class="stage-title">{{ stage.title }}</div>
                <div class="stage-desc">{{ stage.description }}</div>
              </div>
            </article>
          </div>
        </section>

        <section class="panel result-panel">
          <div class="panel-head">
            <div>
              <h3>结果保留区</h3>
            </div>
            <div class="result-head-actions">
              <a-button v-if="snapshot.downloadPath" size="small" type="primary" @click="emit('download')">
                <template #icon><DownloadOutlined /></template>
                下载项目
              </a-button>
            </div>
          </div>

          <div class="snapshot-hero">
            <div class="snapshot-copy">
              <div class="eyebrow">结果快照</div>
              <strong>{{ snapshot.label }}</strong>
              <p>{{ snapshot.description }}</p>
            </div>

            <div class="snapshot-meta">
              <span>激活路由前缀</span>
              <strong>{{ snapshot.activeRule }}</strong>
              <small>{{ snapshot.standaloneBase }}</small>
            </div>
          </div>

          <section class="info-section">
            <div class="section-title">基础信息</div>
            <div class="info-grid">
              <div class="info-item">
                <span>微应用名</span>
                <strong>{{ snapshot.appNameZh }} ({{ snapshot.appName }})</strong>
              </div>
              <div class="info-item">
                <span>子应用 Base</span>
                <strong>{{ snapshot.activeRule }}</strong>
              </div>
              <div class="info-item">
                <span>独立运行 Base</span>
                <strong>{{ snapshot.standaloneBase }}</strong>
              </div>
              <div class="info-item">
                <span>API Base</span>
                <strong>{{ snapshot.apiBase }}</strong>
              </div>
              <div class="info-item info-item-wide">
                <span>代理目标</span>
                <strong>{{ snapshot.proxyTarget }}</strong>
              </div>
              <div class="info-item info-item-wide">
                <span>项目描述</span>
                <strong>{{ snapshot.description }}</strong>
              </div>
            </div>
          </section>

          <section v-if="showAccessSection" class="info-section">
            <div class="section-title">访问与下载</div>
            <div class="info-grid">
              <div class="info-item info-item-wide">
                <span>GitLab 仓库</span>
                <div class="inline-value">
                  <strong :class="{ 'is-clamped': !showGitlabUrlFull }">
                    {{ snapshot.gitlabWebUrl || snapshot.gitlabPath || '-' }}
                  </strong>
                  <div class="inline-actions">
                    <a-button v-if="snapshot.gitlabWebUrl" type="text" size="small" @click="copyText(snapshot.gitlabWebUrl, 'GitLab 链接')">
                      <template #icon><CopyOutlined /></template>
                    </a-button>
                    <a-button v-if="snapshot.gitlabWebUrl" class="gitlab-open-btn" size="small" @click="openGitlab">打开</a-button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section class="code-disclosure" :class="{ expanded: codeExpanded }">
            <div class="code-disclosure-head">
              <button class="code-toggle" type="button" :aria-expanded="codeExpanded" @click="codeExpanded = !codeExpanded">
                <div>
                  <strong>主应用配置</strong>
                  <span>{{ snapshot.configFile }}</span>
                </div>
                <CaretDownOutlined class="code-toggle-icon" />
              </button>
              <a-button class="code-path-btn" size="small" @click="copyText(snapshot.configFile, '配置文件路径')">
                <template #icon><CopyOutlined /></template>
                复制路径
              </a-button>
            </div>

            <div v-show="codeExpanded" class="code-disclosure-body">
              <div class="code-meta">
                <span>配置文件</span>
                <code>{{ snapshot.configFile }}</code>
              </div>

              <pre class="code-block"><code>{{ snapshot.configCode }}</code></pre>

              <div class="code-actions">
                <a-button size="small" @click="copyText(snapshot.configCode, '主应用配置')">
                  <template #icon><CopyOutlined /></template>
                  复制代码
                </a-button>
              </div>
            </div>
          </section>
        </section>
      </div>
    </div>

    <template #footer>
      <div class="drawer-footer">
        <a-space>
          <a-button v-if="snapshot.gitlabWebUrl || snapshot.gitlabPath" type="primary" @click="emit('goto-gitops')">GitOps 配置</a-button>
        </a-space>
        <a-button :disabled="loading" @click="handleClose">关闭</a-button>
      </div>
    </template>
  </a-drawer>
</template>

<style lang="less">
@import './drawer.less';
</style>

<style lang="less" scoped>
@import './style.less';
</style>
