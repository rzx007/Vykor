# Stage 8：Client 平铺兼容门面移除计划

> 状态：已开始，等待发行门禁。执行人：Codex（本阶段不转交其他同事）。

## 1. 最终目标

在外部使用者经历完整迁移窗口后，物理删除 `OpenHarnessClient` 顶层 118 个平铺兼容方法，只保留命名领域 Resource，例如 `client.sessions.create()`、`client.projects.list()` 和 `client.protocol.health()`。删除属于明确的 breaking change，必须放入明确标注破坏性变更的正式版本。

本阶段不自动删除 `transport`、`sse`、`baseUrl`、`token`、`fetchImpl`。这些是高级底层入口，不属于 118 个平铺 facade；是否收窄要依据真实外部使用情况另做决定。

## 2. 当前状态（2026-09-16）

- 仓库生产代码旧调用：0。
- 仓库生产代码旧成员引用：0。
- 兼容方法：118 个，仍保留薄转发和 `@deprecated`。
- 首次弃用发行证据：118/118 为 `pending`。
- 后续保留发行证据：118/118 为 `pending`。
- 删除门禁：`BLOCKED`，这是预期结果，不是测试故障。
- 历史 `v1.x` tag 早于 Stage 7 实现，不能作为本次弃用周期证据。

## 3. 已完成的 Stage 8 准备工作

1. `scripts/client-compat-removal-gate.mjs` 读取公共 API 契约并返回删除资格。
2. 门禁要求每个兼容项都有 `deprecatedCarrierRelease` 和 `retentionCarrierRelease`。
3. 两份证据必须使用统一载体 `@rzx/ohs`，包含版本、日期、channel，以及 release note URL 或构建 commit。
4. 后续保留发行的语义版本和日期必须晚于首次弃用发行。
5. 118 个方法必须共享同一组发行证据，禁止逐项拼接不同版本来凑门槛。
6. `pnpm check:client-removal-gate` 未满足时返回非零，可直接作为删除提交和发布流程的前置检查。

## 4. 发行 A：首次公开弃用

发布包含 Stage 7 代码的 `@rzx/ohs` 正式版本，并在 release notes 中明确写出：

- 顶层平铺方法已经弃用；
- 推荐迁移到命名 Resource；
- 完整迁移表的位置；
- 最早只会在经历一个后续完整保留版本后，于 breaking version 删除。

发布完成后，把同一份真实证据写入全部兼容项的 `deprecatedCarrierRelease`。证据中的 commit 必须是构建该版本的仓库提交，version 必须匹配实际 tag/release。更新后运行公共契约测试、文档检查和删除门禁；此时门禁仍应因为第二份证据 pending 而阻断。

## 5. 发行 B：完整保留周期

在发行 A 之后再发布一个正式稳定版本。该版本继续保留全部 118 个兼容方法，并完成 Client、CLI、Desktop、Frontend、Server 回归。release notes 再次提醒迁移，但不能提前删除或改变旧方法行为。

发布完成后，把同一份真实证据写入全部兼容项的 `retentionCarrierRelease`。其版本和日期必须晚于发行 A。此时运行：

```powershell
pnpm check:client-removal-gate
```

只有输出 `READY` 且退出码为 0，才进入物理删除。

## 6. 物理删除批次

门禁通过后一次完成以下改动，避免长期处于半删除状态：

1. 从 `packages/client/src/transport/http-client.ts` 删除 118 个 deprecated 平铺转发方法。
2. 删除只用于验证旧方法转发的兼容测试；保留命名 Resource 的行为测试。
3. 更新 `scripts/client-public-api-contract.json`：移除已删除成员，递增契约版本并同步 summary。
4. 更新契约测试，使旧方法重新出现时直接失败，而不是建立新的允许基线。
5. 更新迁移指南为“已移除”，保留旧名到新名的查阅表，方便处理升级编译错误。
6. 更新 Client README、根架构状态、release notes 和 breaking version。
7. 全仓搜索旧名称；任何生产调用、类型索引、解构、别名或值传递残留都必须为 0。

## 7. 必须通过的验证

```powershell
pnpm check:client-removal-gate
pnpm check:client-api
pnpm check:architecture
pnpm --filter @openharness/client check-types
pnpm --filter @openharness/client test
pnpm --filter @rzx/ohs check-types
pnpm --filter @rzx/ohs test
pnpm --filter @openharness/desktop typecheck
pnpm --filter @openharness/desktop test
pnpm --filter @openharness/frontend check-types
pnpm --filter @openharness/frontend test
pnpm --filter @openharness/server check-types
pnpm --filter @openharness/server test
node scripts/check-docs.mjs
git diff --check
```

若宿主环境造成 Electron、node-pty 或 WSL 并发失败，应隔离复跑并记录环境原因；不能把真实的类型、契约或业务测试失败归类为环境问题。

## 8. 回滚边界

发行 A 或 B 出现问题时只修复发布或兼容实现，不提前进入删除批次。物理删除合并后若需要回滚，应整体回滚删除提交；不要只恢复部分平铺方法，也不要重新引入仓库内部旧调用。

## 9. 完成定义

阶段 8 只有在以下条件全部成立时才算完成：

- 两次真实发行证据齐全且门禁为 `READY`；
- 118 个平铺方法已经物理删除；
- 命名 Resource 契约和全部消费者验证通过；
- breaking release notes 已发布；
- 架构状态文档标记阶段 8 完成。

当前仅完成准备与自动门禁，尚未满足前两项，因此不得把整个阶段标记为完成。
