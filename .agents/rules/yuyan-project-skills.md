# 雨燕平台项目 Skills

处理任务前按主题读取并遵循以下唯一事实源：

- 双分支协作：`.claude/skills/yuyan-dual-branch-workflow/SKILL.md`
- 自动更新代理：`.claude/skills/yuyan-app-update-proxy/SKILL.md`
- 版本发布：`.claude/skills/yuyan-release-versioning/SKILL.md`

提交代码、发布 Branch、推送、cherry-pick、同步网页端或触发 CI 前，必须读取双分支协作 Skill。默认所有提交都要完成 `feat/github-actions-build` 到 `yuyan-3.0` 的同步闭环；“提交代码”默认包含 commit 和 push，除非用户明确要求跳过。

不要复制或改写规则。规则与代码冲突时，以当前代码和 CI 配置核实事实，并同步修正对应 Skill。
