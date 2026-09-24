# Phase 2 Task 1 报告：Workflow 工具与 Jobs 共用 Repository

## 实现结果

- `LocalAgentJobHost` 改为显式接收 `LocalAgentJobHostOptions`，不再把 cwd、session 和 child manager 作为位置参数。
- Workflow Repository 改为注入的 `WorkflowRunRepository | undefined`。Job Host 不再自行创建文件 Repository；关闭后 `list()`、`read()` 和 `cancel()` 都不会扫描 cwd 中的 Workflow 文件。
- `agent-composition` 继续按 override 规则解析一次 Repository，并把解析出的同一对象同时放入 capability/runtime 工具装配与 `LocalAgentJobHost`。
- SDK 集成测试使用位于 agent cwd 之外的文件 Repository，通过真实 `JobRead` 读取预先写入的 Workflow 快照，避免两个 Repository 仅因指向同一目录而“碰巧共享”。

## 修改文件

- `packages/tools/src/job/local-job-host.ts`
- `packages/tools/src/job/local-job-host.test.ts`
- `packages/agent-runtime/src/agent-composition.ts`
- `packages/agent-runtime/src/sdk.test.ts`
- `.superpowers/sdd/2026-09-01-agent-runtime-default-capabilities-phase-2/task-1-report.md`

## RED/GREEN 证据

- RED：先把 LocalAgentJobHost 测试迁移到目标 options API，并添加显式注入与真正关闭 Workflow 的行为测试。运行聚焦测试时 11/11 失败，失败均为旧构造函数把 options 对象当成 cwd：`The "paths[0]" argument must be of type string. Received an instance of Object`。
- GREEN：实现显式 options、可选 Repository 和装配共享后，同一聚焦测试 11/11 通过。
- SDK GREEN：新增“不同 Repository 目录 + 真实 JobRead”集成测试后，`sdk.test.ts` 10/10 通过。

## 验证结果

```powershell
pnpm --filter @vykor/tools exec vitest run src/job/local-job-host.test.ts src/agent/workflow/__test__/workflow-smoke.test.ts src/agent/workflow/__test__/tool.test.ts
pnpm --filter @vykor/agent-runtime exec vitest run src/sdk.test.ts
pnpm --filter @vykor/tools check-types
pnpm --filter @vykor/agent-runtime check-types
git diff --check
```

- Workflow、Jobs 组合回归：3 个测试文件，30/30 通过。
- Agent Runtime SDK：1 个测试文件，10/10 通过。
- tools 与 agent-runtime TypeScript 类型检查：均退出 0。
- `git diff --check`：退出 0，仅有 Git 的 CRLF 提示。

## 边界说明

- 未处理 Phase 1 ledger 中的 deferred 项，也未修改其他能力装配。
- 用户文件 `apps/desktop/src/main/features/session/session-service.test.ts` 在任务开始前已经 staged；本任务未读取、修改、取消暂存或纳入任务提交。
- 提交将只显式暂存上面列出的 Task 1 文件，绝不使用 `git add .`、`git add apps` 或 `git commit -a`。
