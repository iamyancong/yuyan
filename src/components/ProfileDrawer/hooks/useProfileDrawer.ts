import { computed, ref, watch, type Ref } from 'vue';
import { message } from 'ant-design-vue';
import {
  getCentralUserProfile,
  revokeCentralSession,
  type CentralUserProfile,
} from '@/api/centralIdentity';
import { getAccessibleProjectCount } from '@/api/gitlab';
import { useAuth } from '@/composables/useAuth';
import { loadActiveSecureAccount, type SecureAccountState } from '@/services/secureAuth';
import { openExternal } from '@/utils/open';
import {
  formatProfileDate,
  formatSuccessRate,
  mergeGitlabProfile,
  resolveProfileLoadNotice,
  resolveRoleDisplay,
  type ProfileLoadNotice,
} from '../profilePolicy';

/**
 * 管理「用户资料」抽屉的数据加载、GitLab 信息融合与会话注销。
 */
export function useProfileDrawer(open: Ref<boolean>) {
  const { authState, currentUser, isSystemAdmin, getCurrentUser } = useAuth();

  const loading = ref(false);
  const notice = ref<ProfileLoadNotice | null>(null);
  const profile = ref<CentralUserProfile | null>(null);
  const projectCount = ref<number | null>(null);
  const projectCountLoading = ref(false);
  const revokingSessionId = ref('');
  const activeAccount = ref<SecureAccountState | null>(null);
  let loadSequence = 0;

  const gitlabProfile = computed(() =>
    mergeGitlabProfile(
      profile.value?.gitlab,
      currentUser.value,
      activeAccount.value?.gitlabHost || authState.value.host,
    ),
  );

  const displayInitial = computed(() => {
    const name = gitlabProfile.value.displayName || gitlabProfile.value.username || 'Y';
    return name.trim().charAt(0).toUpperCase() || 'Y';
  });

  const joinDateText = computed(() => formatProfileDate(gitlabProfile.value.createdAt));

  const roleMeta = computed(() =>
    resolveRoleDisplay(profile.value?.identity.role ?? authState.value.role),
  );

  const effectiveIsSystemAdmin = computed(() =>
    profile.value ? Boolean(profile.value.identity.isSystemAdmin) : Boolean(isSystemAdmin.value),
  );

  const successRateText = computed(() => formatSuccessRate(profile.value?.activity.stats30d));

  /** 加载个人资料、可访问 GitLab 项目数与缺失的 GitLab 补充字段。 */
  const loadProfile = async (options: { manual?: boolean } = {}) => {
    const sequence = ++loadSequence;
    loading.value = true;
    notice.value = null;
    projectCountLoading.value = true;

    try {
      const account = await loadActiveSecureAccount(true);
      if (sequence !== loadSequence) return;
      activeAccount.value = account;

      if (!account) {
        profile.value = null;
        projectCount.value = null;
        notice.value = { type: 'warning', message: '当前尚未登录，请先登录后查看个人资料' };
        return;
      }

      const needsGitlabFallback = !currentUser.value?.created_at || !currentUser.value?.web_url;
      const [profileResult, countResult] = await Promise.allSettled([
        getCentralUserProfile(account),
        account.gitlabToken ? getAccessibleProjectCount() : Promise.resolve(null),
        needsGitlabFallback && account.gitlabToken ? getCurrentUser().catch(() => null) : Promise.resolve(null),
      ]);

      if (sequence !== loadSequence) return;

      if (profileResult.status === 'fulfilled') {
        profile.value = profileResult.value;
        if (options.manual) {
          message.success('已刷新用户资料');
        }
      } else {
        notice.value = resolveProfileLoadNotice(profileResult.reason);
      }

      if (countResult.status === 'fulfilled') {
        projectCount.value = countResult.value;
      } else {
        projectCount.value = null;
      }
    } finally {
      if (sequence === loadSequence) {
        loading.value = false;
        projectCountLoading.value = false;
      }
    }
  };

  /** 手动刷新用户资料。 */
  const handleRefresh = () => loadProfile({ manual: true });

  /** 关闭顶部提示条。 */
  const dismissNotice = () => {
    notice.value = null;
  };

  /** 注销当前账号下的其他活跃会话。 */
  const handleRevokeSession = async (sessionId: string) => {
    const account = activeAccount.value || (await loadActiveSecureAccount(true));
    if (!account) {
      message.warning('当前登录状态已失效，请重新登录');
      return;
    }
    revokingSessionId.value = sessionId;
    try {
      await revokeCentralSession(account, sessionId);
      if (profile.value) {
        profile.value = {
          ...profile.value,
          identity: {
            ...profile.value.identity,
            sessions: profile.value.identity.sessions.filter((item) => item.sessionId !== sessionId),
          },
        };
      }
      message.success('已注销该设备会话');
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : '注销会话失败';
      message.error(text);
    } finally {
      revokingSessionId.value = '';
    }
  };

  /** 在浏览器中打开当前用户的 GitLab 主页。 */
  const handleOpenGitlab = async () => {
    const url = gitlabProfile.value.webUrl;
    if (!url) return;
    await openExternal(url);
  };

  watch(
    open,
    (isOpen) => {
      if (isOpen) {
        void loadProfile();
      }
    },
    { immediate: true },
  );

  return {
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
    loadProfile,
    handleRefresh,
    dismissNotice,
    handleRevokeSession,
    handleOpenGitlab,
  };
}
