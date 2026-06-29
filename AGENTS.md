# 雨燕平台 Agent 规范

始终使用中文沟通。修改代码前读取现有实现，保持改动克制，不回滚用户或其他分支已有修改。

处理下列任务前必须读取并遵循对应项目 Skill：

- 分支、提交、推送、cherry-pick、GitHub/GitLab CI：`.claude/skills/yuyan-dual-branch-workflow/SKILL.md`
- 自动更新、更新按钮、GitHub Release、代理下载、缓存、Token：`.claude/skills/yuyan-app-update-proxy/SKILL.md`
- 版本号、Tauri 打包、Release 发布和更新验证：`.claude/skills/yuyan-release-versioning/SKILL.md`

同时涉及多个领域时组合使用相关 Skills。以代码、CI 配置和测试为事实来源；规则与实现冲突时先核实并同步修正规则。
