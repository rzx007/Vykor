# Phase 2 Task 2 Fix Round 2：保存 Completed Run 消息快照

## 复审问题

Fix Round 1 用最新 `user` 消息推导当前 run 起点，但同一个 `submitMessage` run 可以通过 steering 追加多条 `user`。如果本 run 前半段成功调用 `Remember`，随后收到 steered user，最后-user 切片会漏掉已经成功的受管记忆写入，并错误地再次自动提取。

## 修复结果

- `DefaultVykorAgent.submitMessage()` 创建 run 时记录当下 history 长度并清除旧 completed-run 快照。
- `FrameworkAgentRun` 的内部 `onSettled` 回调只在 `execute()` 成功完成时携带 `AgentRunResult`；失败、中断或事件投影异常时传 `undefined`。
- Agent 在 settled 成功时立即复制 `result.history.slice(runHistoryStart)`，保存为独立的 completed-run 消息快照，不长期保存会被后续历史替换破坏的裸索引。
- `AgentMemoryRuntime.remember()` 新增可选内部 `completedRunMessages` 参数：
  - 重复写入判定使用 completed-run 快照；
  - 模型提取 prompt 仍使用完整 history；
  - 没有 completed-run 快照时继续回退到现有历史推导语义，公共 `agent.remember()` 仍保持无参数。
- `loadHistory()` 与 `clear()` 会清除旧快照；`compact()` 不修改已复制的快照，因此压缩或替换当前历史后仍能识别刚完成 run 的成功 `Remember`。
- 下一次独立 run 开始时清除旧快照，成功 settled 后保存新的消息范围，前一 run 不会抑制新 run。

## 修改文件

- `packages/agent-runtime/src/agent.ts`
- `packages/agent-runtime/src/framework-agent-run.ts`
- `packages/agent-runtime/src/memory-runtime.ts`
- `packages/agent-runtime/src/agent.test.ts`
- `.superpowers/sdd/2026-09-01-agent-runtime-default-capabilities-phase-2/task-2-fix-round-2-report.md`

## RED/GREEN 证据

- 第一轮 RED：`agent.test.ts` 为 1 failed / 10 passed。真实流程为 initial user → 成功 `Remember`/result → steered user → run completion；post-run `agent.remember()` 错误返回 `no durable memories proposed`。
- 第一轮 GREEN：保存 completed-run 消息快照并传入 Memory runtime 后，`agent.test.ts` 11/11 通过。
- 生命周期补强 RED：compact 替换历史后快照正确保留；临时移除 `loadHistory()` 快照清理后，加载的新历史仍被旧 `Remember` 快照错误抑制，聚焦测试 1 failed / 10 skipped。
- 生命周期补强 GREEN：恢复 `loadHistory()` 快照清理后，完整 `agent.test.ts` 11/11 通过；同一测试还验证下一次独立 run 使用新边界并执行一次新的提取。

## 验证结果

```powershell
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/agent-runtime check-types
pnpm --filter @vykor/tools exec vitest run src/file/__test__/managed-persistence-path.test.ts
git diff --check
```

- agent-runtime 全 package：13 个测试文件，111/111 通过。
- 受管持久化路径安全：1 个测试文件，3/3 通过。
- agent-runtime TypeScript 类型检查：退出 0。
- `git diff --check`：退出 0，仅有 Git 的 CRLF 提示。

## 边界说明

- `FrameworkAgentRun` 只有 `DefaultVykorAgent` 一个构造调用方；内部回调签名没有扩展公共 SDK。
- 新 run 开始即清除旧快照；失败/取消 run 不会保存伪 completed-run 快照。
- 没有改变 Memory Markdown schema、目录、public `agent.remember()` API 或 capability override。
- 用户 staged 文件 `apps/desktop/src/main/features/session/session-service.test.ts` 未修改、未取消暂存，也不会进入 Round 2 commit。
