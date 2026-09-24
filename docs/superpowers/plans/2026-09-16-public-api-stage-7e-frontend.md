# Stage 7E：Frontend 消费者迁移实施计划

> **面向 AI 代理的工作者：** 使用 superpowers:subagent-driven-development 或 superpowers:executing-plans。先完成所有生产迁移，再统一执行 Frontend 类型检查与测试。

**目标：** 前端 hooks、同步子模块和命令动作只使用命名 Resource/Protocol，并保持 Stage 6 已验证的快照、SSE、cursor 和 daemon 切换语义。

---

## 必查文件与目标能力

- `apps/frontend/src/hooks/useServerSync.ts`：`protocol/system/sessions/providers/jobs`。
- `apps/frontend/src/hooks/sync-submodules/actions.ts`：按实际动作选择 `sessions/projects/permissions/...`；包括 `VykorClient["cancelJob"]` 等类型索引引用。
- `apps/frontend/src/hooks/sessionSlashCommands.ts`：按命令选择 `sessions/system/providers/plugins/development/jobs`。
- 7A AST 报告发现的其他 Frontend 生产文件。

## 任务 1：冻结 Stage 6 行为基线

- [ ] 阅读现有 daemon URL/token rerender、旧 SSE abort、新 Client snapshot/stream、stale snapshot 和 unsupported schema once-only 测试。
- [ ] 运行 `node scripts/client-legacy-calls.mjs --scope production --path apps/frontend/src` 并保存逐文件清单。
- [ ] 为每条旧调用选择 7A 契约表中的命名入口；健康/能力必须归 `protocol`。
- [ ] 明确 Client 生命周期 owner 与纯 action 的边界，避免迁移时改变 effect 依赖。

## 任务 2：迁移 useServerSync

- [ ] 把平铺调用换为 `protocol/system/sessions/providers/jobs` 对应方法。
- [ ] 保持 daemon URL/token 为 effect 依赖；变化时仍先终止旧 SSE，再创建新 Client 并执行 snapshot/stream。
- [ ] 保持 cursor 单调、非零 cursor 需要 initial state、旧 snapshot 拒绝以及 schema 错误只上报一次。
- [ ] 不在 hook 外另建状态仓库，不改变 reducer action 或 loading/error 公开形状。

## 任务 3：迁移 actions 与 slash commands

- [ ] 每个 action 只接收其实际 Resource capability；组件层可以组合，纯函数不接收完整 Client。
- [ ] 替换 `actions.ts` 的会话、项目、权限等平铺调用。
- [ ] 替换 `sessionSlashCommands.ts` 的系统、会话、供应商、插件、开发和 job 调用。
- [ ] 保持 command id、label、参数解析、toast/error 文案和 optimistic update 顺序。
- [ ] 不借机调整 UI、缓存策略或命令功能。

## 任务 4：迁移测试替身并补最小回归

- [ ] fixture 改为命名 Resource 结构，禁止 `any` 或双重 cast。
- [ ] 原有 action/command 用户可见断言全部保留。
- [ ] Stage 6 的 daemon rerender、stale snapshot、controller cursor/state 和 schema once-only 测试必须继续通过。
- [ ] 若 Client 结构变化影响 hook setup，仅补一个能证明资源选择正确的最小测试，不复制 Client 自身 facade 测试。

## 任务 5：静态清单核对与提交

- [ ] 运行 `node scripts/client-legacy-calls.mjs --scope production --path apps/frontend/src`，预期调用和成员引用均为 0。
- [ ] 本波不运行 Frontend 类型检查、测试或根门禁；统一留到 7F，提交说明注明“尚未统一验证”。
- [ ] 更新 baseline 和迁移状态，只允许旧调用数下降。

```bash
git add apps/frontend/src scripts/architecture-baseline.json docs/architecture-migration-status.md
git commit -m "refactor(frontend): use named client resources"
```

## 验收标准

- Frontend 生产旧调用和旧成员引用为 0；
- Stage 6 同步与 daemon 切换语义全部保持；
- actions/commands 依赖收窄；
- 完整类型、测试和架构门禁结果由 7F 给出。
