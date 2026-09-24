# Phase 2 Task 2 报告：固定 Memory 的 agent-runtime 所有权

## 实现结果

- agent-runtime 继续按默认规则创建现有 `AgentMemoryRuntime`，capability snapshot 为 `available/default`，并注册受管 `Remember` 工具。
- `settings.memory.enabled === false` 与 `capabilityOverrides.memory === false` 统一解析为 disabled；两者得到相同 capabilities snapshot，不注册 `Remember`、不设置 memory retriever，`agent.remember()` 返回 `memory is disabled`。
- 自动提取会识别同一 run 中已经发出的受管 `Remember` 调用，不会在主动记忆后再次请求模型提取。
- 现有受管语义保持不变：user scope 继续经过 `appendUserProfileUpdate`，project scope 继续经过现有 `MemoryManager`；模型看到的 `Remember` 工具定义不包含 `USER.md`、`.vykor`、cwd 或真实记忆目录。

## 修改文件

- `packages/agent-runtime/src/agent-composition.ts`
- `packages/agent-runtime/src/memory-runtime.ts`
- `packages/agent-runtime/src/memory-runtime.test.ts`
- `packages/agent-runtime/src/sdk.test.ts`
- `.superpowers/sdd/2026-09-01-agent-runtime-default-capabilities-phase-2/task-2-report.md`

`agent.ts` 与 `remember-tool.test.ts` 已有的 disabled 返回和 user/project scope 回归满足目标契约，因此没有为凑文件清单做无行为价值的改动。

## RED/GREEN 证据

- RED：先添加默认 Memory、两种显式关闭和同一 run 主动 `Remember` 的行为测试。指定 3 文件测试结果为 2 failed / 17 passed。
  - disabled agent 仍能在工具列表看到 `Remember`。
  - 已使用 `Remember` 的 run 仍调用提取模型，返回 `no durable memories proposed`，而不是跳过。
- GREEN：只在现有 Memory runtime 可用时注册 `Remember`，并把 `Remember` 识别为本 run 的受管记忆写入。相同命令随后 19/19 通过。

## 验证结果

```powershell
pnpm --filter @vykor/agent-runtime exec vitest run src/memory-runtime.test.ts src/remember-tool.test.ts src/sdk.test.ts
pnpm --filter @vykor/tools exec vitest run src/file/__test__/managed-persistence-path.test.ts
pnpm --filter @vykor/agent-runtime check-types
git diff --check
```

- Memory、Remember、SDK：3 个测试文件，19/19 通过。
- 受管持久化路径安全：1 个测试文件，3/3 通过。
- agent-runtime TypeScript 类型检查：退出 0。
- `git diff --check`：退出 0，仅有 Git 的 CRLF 提示。

## 边界说明

- 没有引入 `ContextPersistenceService`，没有新增 Memory object override；`AgentCapabilityOverrides.memory` 仍只有 `false` 关闭形式。
- 没有移动 Memory 文件、改变 Markdown schema 或增加新的持久化接口。
- 用户 staged 文件 `apps/desktop/src/main/features/session/session-service.test.ts` 未修改、未取消暂存，也不会纳入 Task 2 提交。
- 提交只显式暂存本报告与上面列出的 Task 2 文件；不使用 `git add .`、`git add apps` 或 `git commit -a`。
