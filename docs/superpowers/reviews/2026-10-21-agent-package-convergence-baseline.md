# Agent 核心包架构收敛 P0 基线

> 状态：当前 P0 实施与验证记录；2026-10-21。P1–P6 尚未开始，业务包没有迁移。

## 1. 范围与环境

- 对应[架构方案](../specs/2026-10-21-agent-package-convergence-design.md)和[实施计划 T00](../plans/2026-10-21-agent-package-convergence.md#t00固定本轮迁移边界)。
- 源码基点：`bd63a584`；工作分支：`codex/agent-convergence-p0`，本记录对应尚未提交的 P0 工作区，不虚构提交身份。
- 平台：Windows / PowerShell；Node `v24.18.1`；pnpm `10.30.2`。
- 按用户要求先编码、集中验证；未启动子 Agent，未建立额外 worktree，未安装新依赖。
- 本次只修改架构检查、对应测试和进度文档；保留工作区中其他技能、资源等已有改动，不纳入本阶段结果。

## 2. 已交付的检查

| 文件 | 本次作用 |
| --- | --- |
| [architecture-policy.json](../../../scripts/architecture-policy.json) | 33 个目标包的直接依赖矩阵、模块规则、具体来源文件的阶段例外 |
| [architecture-policy.schema.json](../../../scripts/architecture-policy.schema.json) | 约束策略字段、迁移编号、阶段、精确例外格式 |
| [architecture-policy.mjs](../../../scripts/architecture-policy.mjs) | AST 导入、导出和声明来源解析；策略验证与例外检查 |
| [architecture-boundaries.mjs](../../../scripts/architecture-boundaries.mjs) | 原有聚合入口接入新策略，继续保留旧分层、循环依赖和退役接口检查 |
| [architecture-boundaries.test.mjs](../../../scripts/architecture-boundaries.test.mjs) | 保留 26 组原检查，新增 9 组边界/策略反例，共 35 项测试 |
| [architecture-baseline.json](../../../scripts/architecture-baseline.json) | 平铺 Store 调用上限由 123 收紧为当前实际的 109 |

源码扫描覆盖 packages/apps 各自 src 下的 TS/TSX/JS 及其模块变体，包括测试与声明文件；不进入 node_modules、dist 等生成目录。解析命名/类型/别名导入、命名/星号/namespace 再导出、内联 import 类型、动态 import、require 和 TS 相对继承配置中的路径映射。Kernel 和路由还追踪显式类型引用的来源，避免通过中间导出文件隐藏宿主或存储类型。

具体保护：

- Kernel 的新目录、现有 Kernel 文件和公开 kernel-entry 都受约束；不能通过 Node 子入口、相对路径、间接导出或外部实现绕过分层。必要的 crypto/util/path 使用保留。
- HTTP 路由从 services 根入口或别名取得 SessionStore/Repository 也会被识别；直接文件 I/O 作为应迁移关系记录。
- contracts 的环境接口只能以类型形式导入，禁止 Node 和外部具体实现。
- 原有包依赖/模块分层和循环检查继续运行；没有替换成只看 package.json 的检查。
- 例外严格匹配 fromFile + target，target 包含规则、来源和声明/类型身份；新增文件、目标或值导入不能借用现有类型导入例外。
- 例外重复、到期、已经失去对应源码关系或被延后到不匹配的迁移阶段都会失败；没有环境变量跳过开关。

## 3. 待迁移关系快照

策略包含当前 30 个包和未来 3 个底层包，当前阶段固定为 P0。扫描生成 **1,128 条精确例外**，按实际源码和 manifest 引用逐项登记，来源文件没有通配符。每条只有 fromFile、target、reason、removeByPhase、migrationId 五个字段。

| 必须删除的阶段 | 例外数 |
| --- | ---: |
| P1 | 490 |
| P2 | 3 |
| P3 | 11 |
| P4 | 580 |
| P5 | 13 |
| P6 | 31 |
| 合计 | 1,128 |

这些是有归属和截止阶段的依赖关系，包含测试和类型引用，不是 1,128 个运行故障，也不表示 P0 已实现目标架构。相同文件经不同导出来源和声明身份暴露的关系分别记录，避免放宽成整个目录或整个包可任意引用。

后续修复一条关系时同步删掉对应例外；阶段推进前清理到期项。不要重新扫描并整体覆盖例外来让检查变绿。本轮没有添加长期放行，P6 仍要求阶段例外为零。

## 4. 必须保持的现有语义

| 基线 | 当前事实与位置 | 本次证据 |
| --- | --- | --- |
| 模型错误身份 | [model-retry.ts](../../../packages/core/src/engine/model-retry.ts)：`Symbol.for("@vykor/core/ModelRequestFailure")` | 源码核对；跨发布 bundle 的完整验证仍归 P6 |
| 执行限制错误身份 | [runtime.ts](../../../packages/core/src/types/runtime.ts)：`Symbol.for("@vykor/core/AgentExecutionLimitError")` | 源码核对 |
| 尝试用量状态 | ModelAttemptUsageStatus 固定为 complete / partial / unknown；未发出用 notDispatched 标记 | 源码核对，不新增持久枚举 |
| Run 回执 | [FrameworkAgentRun](../../../packages/agent-runtime/src/kernel/framework-agent-run.ts) 等待可靠 run.started 后完成 started；终态可靠处理结束后完成 result | Kernel/事件/Child 回归通过；本次未改状态机 |
| 事件观察 | [AgentEventBus](../../../packages/agent-runtime/src/kernel/event-source.ts) 等待唯一可靠 sink；旁观者失败不改变执行结果 | event-source 5 项通过 |
| 子 Agent | 创建归属、ID、输入幂等、树目录、空闲释放、取消/关闭保持当前行为 | child-agent 55 项通过 |
| Goal 尝试唯一键 | [schema.ts](../../../packages/services/src/session-runtime/schema.ts) 的 session_goal_model_attempt 主键为 runId/generationId/attempt；[goal-usage.ts](../../../packages/services/src/goals/goal-usage.ts) 按同一身份查写 | 源码核对；未做 schema 或预算实现改动 |
| 文件 Workflow claim | [文件仓库（P3 后位置）](../../../packages/agent-runtime/src/node/workflow/file-workflow-run-repository.ts) 在本基线中返回 file:pid、generation=1；finish 为空操作 | 源码核对；不具备跨进程互斥保证 |
| SQLite Workflow claim | [workflow-repository.ts](../../../packages/services/src/workflows/workflow-repository.ts) 在事务中递增 generation；同 Application 已 running 的重复 claim 拒绝，其他 owner 可产生新 generation | 源码核对；不将 generation 记录等同于完整的跨进程执行排他 |
| 应用精确授权 | [plugin-app-approval.test.ts](../../../packages/core/src/engine/plugin-app-approval.test.ts) 检查同一 Run/绑定/参数的授权不重复询问，deny/Hook 仍生效，不能借给模型受众调用 | 2 项通过；补充执行以覆盖本阶段要求记录的授权基线 |

## 5. 实际验证

下列命令均在当前工作区执行，退出码均为 0。只统计每组最终结果，不重复累计重跑的测试。

| 命令 | 结果 |
| --- | --- |
| `node --test scripts/architecture-boundaries.test.mjs` | 35/35 通过；在最终 Kernel 入口/内联类型检查补齐后重跑 |
| `node scripts/architecture-boundaries.mjs` | 架构检查通过；Store 平铺调用 109；阶段例外 1,128 |
| `pnpm --filter @vykor/agent-runtime exec vitest run src/kernel.test.ts src/event-source.test.ts src/child-agent.test.ts src/plugin-app-policy.test.ts --maxWorkers=2 --minWorkers=1` | 4 文件、67/67 通过 |
| `pnpm --filter @vykor/server exec vitest run src/application/agent/__test__/daemon-agent-event-projector.test.ts src/application/session/__test__/session-run-executor.test.ts --maxWorkers=2 --minWorkers=1` | 2 文件、72/72 通过 |
| `pnpm --filter @vykor/core exec vitest run src/engine/plugin-app-approval.test.ts --maxWorkers=1 --minWorkers=1` | 1 文件、2/2 通过 |
| `node scripts/check-docs.mjs` | 461 个 Markdown 文件检查通过，含本记录和实施进度链接 |
| `git diff --check -- scripts docs` | 退出码 0，无空白格式错误；Git 的 LF/CRLF 提示不属于检查失败 |

合计 **176 项测试通过**，无失败、跳过或待办；其中运行行为回归 141 项，边界检查测试 35 项。Vitest 限制 worker 数控制资源使用，未运行全仓业务测试、pack、真实 Provider 网络调用或产品界面验证；这些不属于本次仅修改检查脚本的 P0 范围。

## 6. 交付结论与下一阶段

T00 的基线、目标策略、反例、准确例外和指定验证均已建立。A07 的阶段门禁已生效；A07 的最终零例外目标仍属于 P6，不提前勾选。

下一步是 P1/T01–T02，迁移执行叶子契约与本机配置。开始前读取本记录及 policy 中到 P1 截止的 490 条关系，逐项迁移并删除例外；本轮没有开始这部分工作。
