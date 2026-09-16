# Stage 8F：发行 C——Major Breaking Release 与收口

**目标：** 发布实际移除 facade 的 major 版本，验证外部产物并结束重构。

## 发布前

- [ ] 8E 删除提交已合并 main 且 CI 全绿。
- [ ] authorization 为 consumed，targetVersion 与候选版本一致。
- [ ] 目标版本 major 高于 B，minor=0、patch=0。
- [ ] notes 包含 breaking change、迁移表、最低版本和回滚建议。
- [ ] A/B/C 的 tag 和 commit 均不同且可解析。

## 发布

- [ ] 以 `client-breaking-removal` 阶段触发 workflow。
- [ ] preflight 证明旧 facade 已不存在、命名 Resource 完整、gate 为 consumed-ready。
- [ ] 发布 npm CLI、Desktop artifact 和 GitHub Release。
- [ ] 验证 npm 安装后的类型表面不存在 118 个旧方法。
- [ ] 验证新安装 CLI 的关键命令和 daemon/client 路径。

## 发布后与回滚

- [ ] tag、npm、Release 和 workflow commit 一致，latest 指向 C。
- [ ] C 失败时不覆盖 npm；标记坏版本并发布更高 hotfix/前滚版本。
- [ ] 必须恢复时整体恢复 118 项并发布更高版本，同时保持仓库内部零旧调用。

## 状态收口

- [ ] 更新架构状态为阶段 0–8 完成，并写入 A/B/C 全部证据与验证数量。
- [ ] 最终审查无 Critical/Important。
- [ ] 合并、推送及清理分支/worktree 仅在用户明确要求时执行。

## 完成门槛

- [ ] C 已真实发布并验证，而不是只完成代码删除。
- [ ] 永久 tombstone 与架构检查仍在 main 生效。
- [ ] 阶段 8 和整个重构路线正式完成。
