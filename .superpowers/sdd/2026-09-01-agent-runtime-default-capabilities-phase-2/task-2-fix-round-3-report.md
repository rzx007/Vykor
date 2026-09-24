# Phase 2 Task 2 Fix Round 3：独立记录 Run Tool Activity

## 复审问题

Fix Round 2 从 `AgentRunResult.history` 按 run 起始索引复制消息；但 `QueryEngine.autoCompact` 会在同一个 run 内替换或缩短 history。索引和最终 history 已不再描述本 run 的真实消息范围，成功的 `Remember`/result 可能在 settle 前被压缩掉，导致 post-run `agent.remember()` 重复自动提取。

## 修复结果

- `FrameworkAgentRun` 在消费 stream event 时独立记录本 run 的 tool activity：
  - `tool_use_start` 保存 `id`、`name`、`input`；
  - `tool_use_end` 保存 `toolUseId` 与 `isError`；
  - 记录不依赖、也不反推 QueryEngine history。
- 只有成功完成的 run 才通过内部 `onSettled` 回传 tool activity 快照；失败或取消传 `undefined`。
- `DefaultVykorAgent` 在新 run 开始时先保存一个明确的空 activity，成功时替换为该 run 的快照。因此失败/取消 run 不会回退扫描 history 中已经执行过的成功工具调用，也不会沿用前一 run 的事实。
- Memory runtime 的重复写入判定改用 completed-run activity，并继续要求：
  - 工具是 `Remember`，或是通过既有受管 Memory 路径检查的 `Write`/`Edit`；
  - `tool_use_id` 匹配；
  - 对应 tool result 的 `isError !== true`。
- 在没有 completed-run activity 的手动 maintenance 场景，继续使用既有当前历史回退语义。
- 完整 session history 仍用于记忆提取 prompt；公共 `agent.remember()` 仍为无参数。
- 删除 `runHistoryStart` 与 `result.history.slice(...)` 方案，不再使用任何 history 索引作为 run 边界。

## 修改文件

- `packages/agent-runtime/src/agent.ts`
- `packages/agent-runtime/src/framework-agent-run.ts`
- `packages/agent-runtime/src/memory-runtime.ts`
- `packages/agent-runtime/src/agent.test.ts`
- `.superpowers/sdd/2026-09-01-agent-runtime-default-capabilities-phase-2/task-2-fix-round-3-report.md`

## RED/GREEN 证据

- RED：`agent.test.ts` 为 3 failed / 10 passed。
  - 同一 run 内 autoCompact 在成功 `Remember` 前后重写并缩短 history；run 成功后 `agent.remember()` 错误执行提取，返回 `no durable memories proposed`。
  - run 在成功 `Remember` 后 provider failure；`agent.remember()` 错误把未完成 run 的写入当作 completed-run 事实。
  - run 在成功 `Remember` 后 cancellation；同样错误抑制后续提取。
- GREEN：独立记录 stream tool activity，并仅在成功 settle 保存快照后，`agent.test.ts` 13/13 通过。

## 验证结果

```powershell
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/agent-runtime check-types
pnpm --filter @vykor/tools exec vitest run src/file/__test__/managed-persistence-path.test.ts
git diff --check
```

- agent-runtime 全 package：13 个测试文件，113/113 通过。
- agent-runtime TypeScript 类型检查：退出 0。
- 受管持久化路径安全：1 个测试文件，3/3 通过。
- `git diff --check`：退出 0，仅有 Git 的 CRLF 提示。

## 边界说明

- `FrameworkAgentRun` 的 tool activity 与 `onSettled` 都是内部实现，没有扩展公共 SDK。
- steering user 不参与去重边界；同一 run 的所有 tool activity 都由同一个 run 对象记录。
- autoCompact、手动 compact 或 history 替换都不会改变已经记录的 run activity。
- `loadHistory()` 与 `clear()` 仍会清除旧 completed-run activity；`compact()` 保留最近成功 run 的 activity。
- 没有改变 Memory Markdown schema、目录、受管路径规则、public `agent.remember()` API 或 capability override。
- 用户 staged 文件 `apps/desktop/src/main/features/session/session-service.test.ts` 未修改、未取消暂存，也不会进入 Round 3 commit。
