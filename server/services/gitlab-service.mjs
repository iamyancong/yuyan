/**
 * GitLab API 服务
 * @description 封装所有 GitLab API 操作
 */

import { parseGitlabApiError } from '../utils/error-parser.mjs';

/**
 * 规范化 GitLab Host URL
 * @param {string} host - GitLab 地址
 * @returns {string} 规范化后的基础 URL
 */
function normalizeGitlabHost(host) {
  try {
    const u = new URL(host);
    return `${u.protocol}//${u.host}`;
  } catch {
    return String(host || '').replace(/\/$/, '');
  }
}

/**
 * 创建 GitLab 项目
 * @param {Object} params - 创建参数
 * @param {string} params.host - GitLab 地址
 * @param {string} params.token - GitLab Token
 * @param {string} params.name - 项目名称
 * @param {string} [params.namespaceId] - 命名空间 ID
 * @param {string} [params.visibility='private'] - 可见性（private/internal/public）
 * @param {string} [params.description] - 项目描述
 * @returns {Promise<Object>} GitLab 项目信息
 */
export async function createProject({ host, token, name, namespaceId, visibility = 'private', description }) {
  const base = normalizeGitlabHost(host);
  const url = `${base}/api/v4/projects`;

  const payload = {
    name,
    path: name,
    visibility,
    topics: ['yuyan-ops'],
    tag_list: ['yuyan-ops'],
  };

  if (description) payload.description = description;
  if (namespaceId) payload.namespace_id = Number(namespaceId);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PRIVATE-TOKEN': token,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitLab 创建项目失败: ${res.status} ${res.statusText} ${text}`);
    }

    const project = await res.json();
    console.log('[gitlab-service] 项目创建成功:', project.name);
    return project;
  } catch (error) {
    const friendlyError = parseGitlabApiError(error, '创建项目');
    throw new Error(friendlyError);
  }
}

/**
 * 更新 GitLab 项目信息
 * @param {Object} params - 更新参数
 * @param {string} params.host - GitLab 地址
 * @param {string} params.token - GitLab Token
 * @param {string|number} params.projectId - 项目 ID
 * @param {string} [params.description] - 项目描述
 * @returns {Promise<Object>} 更新后的项目信息
 */
export async function updateProject({ host, token, projectId, description }) {
  const base = normalizeGitlabHost(host);
  const url = `${base}/api/v4/projects/${encodeURIComponent(projectId)}`;

  const payload = {
    topics: ['yuyan-ops'],
    tag_list: ['yuyan-ops'],
  };

  if (typeof description === 'string') payload.description = description;

  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'PRIVATE-TOKEN': token,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitLab 更新项目失败: ${res.status} ${res.statusText} ${text}`);
    }

    const project = await res.json();
    console.log('[gitlab-service] 项目更新成功:', projectId);
    return project;
  } catch (error) {
    const friendlyError = parseGitlabApiError(error, '更新项目');
    throw new Error(friendlyError);
  }
}

/**
 * 删除 GitLab 项目（用于回滚操作）
 * @param {Object} params - 删除参数
 * @param {string} params.host - GitLab 地址
 * @param {string} params.token - GitLab Token
 * @param {string|number} params.projectId - 项目 ID
 * @returns {Promise<Object>} 删除结果
 */
export async function deleteProject({ host, token, projectId }) {
  const base = normalizeGitlabHost(host);
  const url = `${base}/api/v4/projects/${encodeURIComponent(projectId)}`;

  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        'PRIVATE-TOKEN': token,
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitLab 删除项目失败: ${res.status} ${res.statusText} ${text}`);
    }

    console.log('[gitlab-service] 项目删除成功:', projectId);

    // DELETE 成功时可能返回 202 Accepted 或 204 No Content
    if (res.status === 204) return { success: true };
    return res.json().catch(() => ({ success: true }));
  } catch (error) {
    const friendlyError = parseGitlabApiError(error, '删除项目');
    throw new Error(friendlyError);
  }
}
/**
 * 检查 Token 权限是否足够（能否删除项目）
 * @param {Object} params - 检查参数
 * @param {string} params.host - GitLab 地址
 * @param {string} params.token - GitLab Token
 * @param {string} [params.namespaceId] - 命名空间 ID（用于检查项目级别权限）
 * @returns {Promise<{canDelete: boolean, userInfo: Object, tokenScopes: string, reason: string}>} 权限检查结果
 */
export async function checkTokenPermissions({ host, token, namespaceId }) {
  const base = normalizeGitlabHost(host);

  try {
    // 1. 获取当前用户信息
    const userUrl = `${base}/api/v4/user`;
    const userRes = await fetch(userUrl, {
      headers: { 'PRIVATE-TOKEN': token },
    });

    if (!userRes.ok) {
      return {
        canDelete: false,
        userInfo: null,
        tokenScopes: null,
        reason: `Token 无效或过期 (HTTP ${userRes.status})`,
      };
    }

    const user = await userRes.json();

    // 2. 获取 Token scopes - 使用专门的 API
    let tokenScopes = '';
    let scopes = [];
    let scopeDetected = false; // 标识是否成功获取到了 scope 信息

    try {
      // 优先使用 /personal_access_tokens/self API（GitLab 13.0+）
      const tokenInfoUrl = `${base}/api/v4/personal_access_tokens/self`;
      const tokenInfoRes = await fetch(tokenInfoUrl, {
        headers: { 'PRIVATE-TOKEN': token },
      });
      if (tokenInfoRes.ok) {
        const tokenInfo = await tokenInfoRes.json();
        scopes = tokenInfo.scopes || [];
        tokenScopes = scopes.join(', ');
        scopeDetected = scopes.length > 0;
        console.log('[gitlab-service] Token scopes (from API):', tokenScopes);
      } else {
        // 降级方案：尝试从响应头获取
        const headerScopes = userRes.headers.get('x-oauth-scopes') || '';
        scopes = headerScopes
          ? headerScopes
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
        tokenScopes = headerScopes;
        scopeDetected = scopes.length > 0;
        console.log('[gitlab-service] Token scopes (from header):', tokenScopes || '(未检测到)');
      }
    } catch (error) {
      console.warn('[gitlab-service] 无法获取 Token scopes:', error.message);
      // 使用响应头作为后备
      const headerScopes = userRes.headers.get('x-oauth-scopes') || '';
      scopes = headerScopes
        ? headerScopes
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      tokenScopes = headerScopes;
      scopeDetected = scopes.length > 0;
    }

    console.log('[gitlab-service] 用户信息:', {
      username: user.username,
      name: user.name,
      email: user.email,
      is_admin: user.is_admin,
    });
    console.log('[gitlab-service] Token scopes:', tokenScopes || '(未检测到)');

    // 3. 如果提供了 namespaceId，检查用户在该 namespace 下的权限
    let namespaceRole = null;
    let accessLevel = 0;
    if (namespaceId) {
      try {
        const namespaceUrl = `${base}/api/v4/namespaces/${namespaceId}`;
        const namespaceRes = await fetch(namespaceUrl, {
          headers: { 'PRIVATE-TOKEN': token },
        });

        if (namespaceRes.ok) {
          const namespace = await namespaceRes.json();
          console.log('[gitlab-service] Namespace 信息:', {
            name: namespace.name,
            full_path: namespace.full_path,
            kind: namespace.kind,
          });

          // 尝试获取成员信息
          if (namespace.kind === 'group') {
            try {
              let memberUrl = `${base}/api/v4/groups/${namespaceId}/members/all/${user.id}`;
              let memberRes = await fetch(memberUrl, {
                headers: { 'PRIVATE-TOKEN': token },
              });

              if (!memberRes.ok) {
                memberUrl = `${base}/api/v4/groups/${namespaceId}/members/${user.id}`;
                memberRes = await fetch(memberUrl, {
                  headers: { 'PRIVATE-TOKEN': token },
                });
              }

              if (memberRes.ok) {
                const member = await memberRes.json();
                // access_level: 10=Guest, 20=Reporter, 30=Developer, 40=Maintainer, 50=Owner
                const roleMap = {
                  10: 'Guest',
                  20: 'Reporter',
                  30: 'Developer',
                  40: 'Maintainer',
                  50: 'Owner',
                };
                accessLevel = member.access_level;
                namespaceRole = roleMap[accessLevel] || `Level ${accessLevel}`;
                console.log('[gitlab-service] 用户角色:', namespaceRole, 'access_level:', accessLevel);
              }
            } catch {}
          }
        }
      } catch (error) {
        console.warn('[gitlab-service] 无法获取 namespace 权限:', error.message);
      }
    }

    // 4. 构建详细的用户信息
    const userInfo = {
      username: user.username,
      name: user.name,
      email: user.email,
      isAdmin: user.is_admin,
      namespaceRole,
      accessLevel,
    };

    // 5. 判断权限
    const hasApiScope = scopes.includes('api');
    const isAdmin = user.is_admin;
    // 在 Group 下创建项目通常需要 Maintainer (40) 以上权限
    const canCreateInGroup = isAdmin || accessLevel >= 40;

    // 管理员拥有完整权限
    if (isAdmin) {
      return {
        canDelete: true,
        canCreate: true,
        userInfo,
        tokenScopes,
        reason: '管理员账号，拥有完整权限',
      };
    }

    // 6. Token scope 判断策略（宽容模式）
    // - 如果成功检测到 scopes 且包含 api → canDelete=true
    // - 如果无法检测到 scopes（自建 GitLab 可能不支持 scope 自检）→ canDelete=true（宽容放行）
    //   因为 Token 既然能成功调用 /api/v4/user 等接口，说明实际权限是足够的
    // - 如果检测到 scopes 但不包含 api → canDelete=false（明确缺少权限）
    const tokenHasPermission = !scopeDetected || hasApiScope;

    console.log('[gitlab-service] Token 权限判断:', {
      scopeDetected,
      hasApiScope,
      tokenHasPermission,
      canCreateInGroup,
    });

    // 分析具体缺失
    return {
      canDelete: tokenHasPermission,
      canCreate: canCreateInGroup,
      userInfo,
      tokenScopes: tokenScopes || '(未检测到，已宽容放行)',
      reason:
        !tokenHasPermission && !canCreateInGroup
          ? 'Token 明确缺少 api scope，且用户角色不足'
          : !tokenHasPermission
            ? 'Token 明确缺少 api scope（请在 GitLab 个人设置中勾选 api 权限）'
            : !canCreateInGroup
              ? '用户角色不足（需要 Maintainer 以上）'
              : scopeDetected
                ? '权限充足'
                : '权限充足（Token scope 未检测到，已宽容放行）',
    };
  } catch (error) {
    console.error('[gitlab-service] Token 权限检查失败:', error);
    return {
      canDelete: false,
      canCreate: false,
      userInfo: null,
      tokenScopes: null,
      reason: `权限检查失败: ${error.message}`,
    };
  }
}
