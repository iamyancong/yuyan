/**
 * Git/GitLab 错误解析器
 * @description 将技术错误信息转换为用户友好的提示
 */

/**
 * 解析 Git 推送错误并返回用户友好的错误信息
 * @param {Error | string} error - Git 命令抛出的错误对象或字符串
 * @returns {string} 格式化的用户友好错误提示
 */
export function parseGitPushError(error) {
  const errorMessage = error instanceof Error ? error.message : String(error);

  // 1. 权限不足 - pre-receive hook 拒绝
  if (errorMessage.includes('pre-receive hook declined') || errorMessage.includes('remote rejected')) {
    if (errorMessage.includes('default branch') || errorMessage.includes('does not yet exist')) {
      return (
        '❌ 代码推送失败：当前账号没有创建默认分支的权限（需要 Owner 或 Maintainer 角色）\n' +
        '💡 解决方案：请联系项目管理员为您分配 Maintainer 以上权限，或由管理员手动创建默认分支'
      );
    }
    return (
      '❌ 代码推送失败：当前账号没有推送代码的权限（需要 Maintainer 或 Owner 角色）\n' + '💡 解决方案：请联系项目管理员授予您 Maintainer 以上权限'
    );
  }

  // 2. 认证失败
  if (errorMessage.includes('Authentication failed') || errorMessage.includes('401')) {
    return '❌ 代码推送失败：GitLab Token 认证失败\n' + '💡 解决方案：请检查 Token 是否正确，或重新登录获取新的 Token';
  }

  // 3. 网络连接问题
  if (errorMessage.includes('Could not resolve host') || errorMessage.includes('Connection refused')) {
    return '❌ 代码推送失败：无法连接到 GitLab 服务器\n' + '💡 解决方案：请检查网络连接或 GitLab 服务器状态';
  }

  // 4. 仓库不存在
  if (errorMessage.includes('Repository not found') || errorMessage.includes('404')) {
    return '❌ 代码推送失败：GitLab 仓库未找到\n' + '💡 这可能是系统错误，请稍后重试或联系管理员';
  }

  // 5. 其他 Git 错误
  if (errorMessage.includes('git')) {
    return `❌ 代码推送失败：${errorMessage}\n` + '💡 解决方案：请检查 Git 配置或联系技术支持';
  }

  // 6. 未知错误
  return `❌ 代码推送失败：${errorMessage}\n` + '💡 解决方案：请联系技术支持';
}

/**
 * 解析 GitLab API 错误
 * @param {Error | string} error - GitLab API 错误
 * @param {string} operation - 操作类型（创建/更新/删除）
 * @returns {string} 用户友好的错误提示
 */
export function parseGitlabApiError(error, operation = '操作') {
  const errorMessage = error instanceof Error ? error.message : String(error);

  if (errorMessage.includes('401') || errorMessage.includes('Unauthorized')) {
    return `❌ GitLab ${operation}失败：Token 认证失败\n💡 解决方案：请检查 GitLab Token 是否正确`;
  }

  if (errorMessage.includes('403') || errorMessage.includes('Forbidden')) {
    return `❌ GitLab ${operation}失败：权限不足\n💡 解决方案：请确保 Token 具有足够的权限`;
  }

  if (errorMessage.includes('404') || errorMessage.includes('Not Found')) {
    return `❌ GitLab ${operation}失败：资源未找到\n💡 解决方案：请检查项目 ID 或 Namespace ID 是否正确`;
  }

  if (errorMessage.includes('400') || errorMessage.includes('Bad Request')) {
    return `❌ GitLab ${operation}失败：请求参数错误\n💡 详细信息：${errorMessage}`;
  }

  return `❌ GitLab ${operation}失败：${errorMessage}`;
}
