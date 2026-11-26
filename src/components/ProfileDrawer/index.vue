<script setup lang="ts">
import { computed } from 'vue';
import { Empty } from 'ant-design-vue';
import {
  CalendarOutlined,
  CloseOutlined,
  DesktopOutlined,
  ExportOutlined,
  FolderOpenOutlined,
  HistoryOutlined,
  LaptopOutlined,
  LogoutOutlined,
  MailOutlined,
  ReloadOutlined,
  RocketOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons-vue';
import { YButton } from '@yss-ui/components/lite';
import { useTheme } from '@/hooks/useTheme';
import { PROFILE_DRAWER_WIDTH } from './constant';
import { useProfileDrawer } from './hooks/useProfileDrawer';
import {
  canRevokeSessionItem,
  formatProfileDateTime,
  resolveDeployActionLabel,
  resolveDeployStatusMeta,
  resolvePlatformLabel,
  shortenDeviceId,
} from './profilePolicy';

defineOptions({ name: 'ProfileDrawer' });

interface ProfileDrawerProps {
  /** 抽屉是否打开 */
  open: boolean;
}

const props = defineProps<ProfileDrawerProps>();

const emit = defineEmits<{
  /** 更新抽屉打开状态 */
  (e: 'update:open', value: boolean): void;
}>();

const { isDark } = useTheme();

const drawerOpen = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
});

const drawerRootClass = computed(
  () => `profile-drawer-root profile-drawer-root--${isDark.value ? 'dark' : 'light'}`,
);

const {
  loading,
  notice,
  profile,
  gitlabProfile,
  displayInitial,
  joinDateText,
  roleMeta,
  effectiveIsSystemAdmin,
  projectCount,
  projectCountLoading,
  successRateText,
  revokingSessionId,
  handleRefresh,
  dismissNotice,
  handleRevokeSession,
  handleOpenGitlab,
} = useProfileDrawer(computed(() => props.open));

const sessions = computed(() => profile.value?.identity.sessions || []);
const recentDeploys = computed(() => profile.value?.activity.recentDeploys || []);
const stats30d = computed(() => profile.value?.activity.stats30d);
const isWebOnlyMode = computed(() => profile.value?.identity.authMode === 'web_gitlab');

const closeDrawer = () => {
  drawerOpen.value = false;
};
</script>

<template>
  <a-drawer
    :open="drawerOpen"
    :width="PROFILE_DRAWER_WIDTH"
    placement="right"
    :root-class-name="drawerRootClass"
    :closable="false"
    :body-style="{ padding: 0 }"
    :destroy-on-close="false"
    @close="closeDrawer"
  >
    <template #title>
      <div class="profile-drawer-header">
        <div class="profile-drawer-header__identity">
          <span class="profile-drawer-header__mark"><UserOutlined /></span>
          <div>
            <div class="profile-drawer-header__eyebrow">Yuyan Account &amp; Identity</div>
            <h2 class="profile-drawer-header__title">用户资料</h2>
          </div>
        </div>
        <div class="profile-drawer-header__actions">
          <a-tooltip :title="loading ? '正在刷新资料…' : '刷新资料'" placement="bottom">
            <button
              class="profile-drawer-header__icon-btn profile-drawer-header__icon-btn--refresh"
              :class="{ 'is-loading': loading }"
              type="button"
              :disabled="loading"
              aria-label="刷新用户资料"
              @click="handleRefresh"
            >
              <ReloadOutlined :spin="loading" />
            </button>
          </a-tooltip>
          <a-tooltip title="关闭" placement="bottom">
            <button
              class="profile-drawer-header__icon-btn profile-drawer-header__icon-btn--close"
              type="button"
              aria-label="关闭用户资料"
              @click="closeDrawer"
            >
              <CloseOutlined />
            </button>
          </a-tooltip>
        </div>
      </div>
    </template>

    <div class="profile-drawer-shell" :class="{ 'profile-drawer-shell--dark': isDark }">
      <a-spin :spinning="loading && !profile">
        <div class="profile-drawer-body">
          <a-alert
            v-if="notice"
            :type="notice.type"
            show-icon
            closable
            :message="notice.message"
            class="profile-alert"
            @close="dismissNotice"
          />

          <!-- 1. GitLab 信息 -->
          <section class="profile-card profile-hero-card">
            <div class="profile-hero-top">
              <div class="profile-hero-identity">
                <a-avatar :size="60" :src="gitlabProfile.avatarUrl" class="profile-hero-avatar">
                  {{ displayInitial }}
                </a-avatar>
                <div class="profile-hero-meta">
                  <div class="profile-hero-name-row">
                    <h3 class="profile-hero-name">{{ gitlabProfile.displayName }}</h3>
                    <a-tag
                      v-if="effectiveIsSystemAdmin"
                      color="gold"
                      class="profile-sysadmin-badge"
                    >
                      <template #icon><SafetyCertificateOutlined /></template>
                      系统管理员
                    </a-tag>
                  </div>
                  <div class="profile-hero-sub">
                    <span v-if="gitlabProfile.username" class="profile-handle">@{{ gitlabProfile.username }}</span>
                    <span v-if="gitlabProfile.host" class="profile-host-pill" :title="gitlabProfile.host">
                      {{ gitlabProfile.host }}
                    </span>
                  </div>
                </div>
              </div>

              <YButton
                v-if="gitlabProfile.webUrl"
                type="primary"
                ghost
                size="small"
                class="profile-gitlab-link-btn"
                @click="handleOpenGitlab"
              >
                <template #icon><ExportOutlined /></template>
                在 GitLab 中打开
              </YButton>
            </div>

            <div class="profile-meta-grid">
              <div class="profile-meta-item">
                <span class="profile-meta-label"><MailOutlined /> GitLab 邮箱</span>
                <span class="profile-meta-value" :class="{ 'is-muted': !gitlabProfile.email }">
                  {{ gitlabProfile.email || '未设置公开邮箱' }}
                </span>
              </div>
              <div class="profile-meta-item">
                <span class="profile-meta-label"><CalendarOutlined /> GitLab 加入日期</span>
                <span class="profile-meta-value" :class="{ 'is-muted': joinDateText === '未知' }">
                  {{ joinDateText }}
                </span>
              </div>
            </div>
          </section>

          <!-- 2. 雨燕身份 -->
          <section class="profile-card">
            <div class="profile-section-head">
              <div>
                <h4 class="profile-section-title"><TeamOutlined /> 雨燕身份</h4>
                <p class="profile-section-desc">工作区归属、权限角色与当前账号的已登录设备会话</p>
              </div>
            </div>

            <div class="profile-identity-summary">
              <div class="profile-identity-tile">
                <span class="profile-meta-label">当前工作区 / 团队</span>
                <div class="profile-identity-tile__value">
                  <template v-if="profile?.identity.team">
                    <strong>{{ profile.identity.team.name }}</strong>
                    <code class="profile-code-chip">{{ profile.identity.team.id }}</code>
                  </template>
                  <span v-else-if="profile" class="is-muted">网页临时会话（未绑定中央工作区）</span>
                  <span v-else class="is-muted">暂未获取到中央工作区信息</span>
                </div>
              </div>

              <div class="profile-identity-tile">
                <span class="profile-meta-label">工作区角色</span>
                <div class="profile-identity-tile__value">
                  <a-tag :color="roleMeta.color">{{ roleMeta.label }}</a-tag>
                  <span class="profile-role-hint">{{ roleMeta.description }}</span>
                </div>
              </div>
            </div>

            <div class="profile-sessions-block">
              <div class="profile-sessions-head">
                <div>
                  <strong>已登录设备与会话</strong>
                  <span class="profile-sessions-sub">
                    {{
                      isWebOnlyMode
                        ? '当前浏览器标签页以 GitLab PAT 鉴权；下方列出账号已登记的桌面端活跃会话'
                        : '当前会话受保护不可注销；可随时注销其他设备上的活跃会话'
                    }}
                  </span>
                </div>
                <a-tag>{{ sessions.length }} 个活跃会话</a-tag>
              </div>

              <div v-if="sessions.length" class="profile-session-list">
                <article
                  v-for="session in sessions"
                  :key="session.sessionId"
                  class="profile-session-item"
                  :class="{ 'is-current': session.isCurrent }"
                >
                  <span class="profile-session-item__icon">
                    <LaptopOutlined v-if="session.platform === 'macos'" />
                    <DesktopOutlined v-else />
                  </span>
                  <div class="profile-session-item__content">
                    <div class="profile-session-item__title">
                      <strong>{{ session.deviceName }}</strong>
                      <a-tag v-if="session.isCurrent" color="success">当前会话</a-tag>
                      <a-tag v-else color="blue">{{ resolvePlatformLabel(session.platform) }}</a-tag>
                    </div>
                    <div class="profile-session-item__meta">
                      <span>{{ resolvePlatformLabel(session.platform) }}</span>
                      <span>·</span>
                      <span>最近活跃 {{ formatProfileDateTime(session.lastSeenAt) }}</span>
                      <span>·</span>
                      <code :title="session.deviceId">{{ shortenDeviceId(session.deviceId) }}</code>
                    </div>
                  </div>

                  <a-popconfirm
                    v-if="canRevokeSessionItem(session)"
                    title="注销后该设备会话将立即失效，需重新登录验证，确定注销吗？"
                    ok-text="确定注销"
                    cancel-text="取消"
                    @confirm="handleRevokeSession(session.sessionId)"
                  >
                    <YButton
                      danger
                      size="small"
                      :loading="revokingSessionId === session.sessionId"
                    >
                      <template #icon><LogoutOutlined /></template>
                      注销
                    </YButton>
                  </a-popconfirm>
                </article>
              </div>

              <div v-else class="profile-empty-note">
                {{
                  !profile && notice
                    ? '暂未获取到设备会话（待中央服务个人资料接口就绪后展示）。'
                    : '暂无活跃桌面设备会话（仅在雨燕桌面端登录后登记设备会话）。'
                }}
              </div>
            </div>
          </section>

          <!-- 3. 我的活动 -->
          <section class="profile-card">
            <div class="profile-section-head">
              <div>
                <h4 class="profile-section-title"><RocketOutlined /> 我的活动</h4>
                <p class="profile-section-desc">近 30 天由当前账号发起的部署表现与最近 10 条发布记录</p>
              </div>
            </div>

            <div class="profile-stats-grid">
              <div class="profile-stat-box">
                <span class="profile-stat-label">近 30 天发布</span>
                <strong class="profile-stat-value">{{ stats30d?.totalCount ?? 0 }}</strong>
                <span class="profile-stat-sub">
                  成功 {{ stats30d?.successCount ?? 0 }} · 失败 {{ stats30d?.failedCount ?? 0 }}
                </span>
              </div>

              <div class="profile-stat-box">
                <span class="profile-stat-label">30 天成功率</span>
                <strong class="profile-stat-value">{{ successRateText }}</strong>
                <span class="profile-stat-sub">
                  {{
                    stats30d?.finishedCount
                      ? `基于 ${stats30d.finishedCount} 次已结束发布`
                      : '暂无已结束记录'
                  }}
                </span>
              </div>

              <div class="profile-stat-box">
                <span class="profile-stat-label"><FolderOpenOutlined /> 可访问 GitLab 项目</span>
                <strong class="profile-stat-value">
                  {{ projectCountLoading ? '...' : (projectCount ?? '--') }}
                </strong>
                <span class="profile-stat-sub">
                  {{ projectCount !== null ? '含成员权限仓库' : '暂未获取到项目计数' }}
                </span>
              </div>
            </div>

            <div class="profile-deploys-block">
              <div class="profile-deploys-head">
                <strong><HistoryOutlined /> 最近发布记录（最多 10 条）</strong>
              </div>

              <div v-if="recentDeploys.length" class="profile-deploy-list">
                <article
                  v-for="record in recentDeploys"
                  :key="record.id"
                  class="profile-deploy-item"
                >
                  <div class="profile-deploy-item__main">
                    <div class="profile-deploy-item__title">
                      <a-tag :color="resolveDeployStatusMeta(record.status).color">
                        {{ resolveDeployStatusMeta(record.status).label }}
                      </a-tag>
                      <strong class="profile-deploy-project">{{ record.projectName || `目标 #${record.targetId}` }}</strong>
                      <a-tag v-if="record.envName" class="profile-env-tag">{{ record.envName }}</a-tag>
                      <span class="profile-deploy-action">{{ resolveDeployActionLabel(record.action) }}</span>
                    </div>
                    <div class="profile-deploy-item__meta">
                      <span v-if="record.branch">分支 <code>{{ record.branch }}</code></span>
                      <span v-if="record.commitSha">· <code>{{ record.commitSha.slice(0, 7) }}</code></span>
                      <span v-if="record.serverName">· {{ record.serverName }}</span>
                    </div>
                  </div>
                  <div class="profile-deploy-item__time">
                    {{ formatProfileDateTime(record.startedAt) }}
                  </div>
                </article>
              </div>

              <div v-else-if="!profile && notice" class="profile-empty-note">
                暂未获取到发布记录（待中央服务个人资料接口就绪后展示）。
              </div>

              <a-empty
                v-else
                description="暂无由当前账号发起的发布记录"
                :image="Empty.PRESENTED_IMAGE_SIMPLE"
              />
            </div>
          </section>
        </div>
      </a-spin>
    </div>
  </a-drawer>
</template>

<style scoped lang="less">
@import './style.less';
</style>
