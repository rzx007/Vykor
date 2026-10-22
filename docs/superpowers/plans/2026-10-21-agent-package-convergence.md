# Agent 核心包架构收敛实施计划

> 状态：当前实施计划；2026-10-21 基于 `bd63a584` 编写，2026-10-22 完成 P5。P0–P5 已完成并验证，P6 尚未开始；最新证据见 [P5 验证记录](../reviews/2026-10-22-agent-package-convergence-p5.md)。
> **For agentic workers:** 仅在用户要求开始实施后使用 executing-plans 按阶段执行。只有用户或适用指令明确授权时才使用 subagent-driven-development；本计划不要求自动启动子 Agent。

**Goal:** 收敛 packages 的执行、宿主和持久化职责，使新增能力不再要求修改多个核心控制层，同时保持现有执行和数据语义。

**Architecture:** 新增 agent-contracts、host-config、execution-node 三个内部包；现有 agent-runtime 内部分开 Kernel 和 Node 组装，coordinator 保留定义与纯调度，工具通过窄能力接口调用宿主。Server 持有持久状态和显式模型尝试准入。

**Tech Stack:** TypeScript、pnpm workspace、Vitest、Node test、esbuild、SQLite/Drizzle、现有 HTTP/SSE 和平台执行环境；不新增第三方框架。

**Spec:** [Agent 核心包架构收敛方案](../specs/2026-10-21-agent-package-convergence-design.md)。包矩阵、接口含义、M01–M33 迁移表和 A/B 验收编号均以该方案为准。

## Global Constraints

- 当前授权范围截至 P5：完成前述拆分、显式模型尝试准入与 Goal 记账，以及维护/事实/便签应用用例；P6 尚未启动。不发布、不部署、不重置用户数据。
- 最终新增三个内部包：`@vykor/agent-contracts`、`@vykor/host-config`、`@vykor/execution-node`；其他职责先在现有包内分目录、子入口管理。
- 保留会话排队、事务、可靠事件处理和子 Agent 生命周期；先移动职责和缩小接口，再整理大文件。
- 每阶段形成可编译、可运行的完整切面，不提交只有新接口、实际调用仍走旧实现的空架构。
- HTTP/SSE 请求、响应和持久记录的现有格式；本次不主动升级协议版本或修改 SQLite schema。
- 不重置用户数据库、凭据、插件、记忆或工作目录；不迁移实际用户文件。
- 不新增通用 Manager、万能 Context、动态服务查找器或任意名称的生命周期插件系统。
- 文件版 Workflow 用于独立宿主，SQLite 版用于 daemon；两种存储不自动互相接管。
- 测试、类型导入、动态导入和相对路径跨包引用也受约束。
- 代码回退以阶段/任务的完整提交为单位，不通过重新增加旧 API 维持半迁移状态。
- UI 本轮没有样式调整；不主动搭建预览、截图或验证样式。

## 1. 执行方法和边界

P0 按用户要求先编码、集中测试，不启动子 Agent；新增反例与检查实现一起验证。后续任务先补能够证明职责/行为的断言，再移动实现并同步实际使用者，最后运行相应检查。纯搬迁已有测试直接迁移，只有缺少行为证据时才新增测试，不为每个转发方法单独写镜像测试。

新目标路径均标为“新建”，当前已有测试按实施时实际位置跟随移动。命令中的新路径在对应步骤完成后才存在，不能在今天把这些未来命令记录为已通过。

API 重命名不使用旧实现兼容层。同一任务更新被影响的 package.json、TypeScript 导入、SDK 声明、apps/scripts/tests 使用者和文档。可以在开发分支内分多次编辑，但每个阶段只合入已能完整运行的结果。

### 1.1 阶段依赖和交付单元

```mermaid
flowchart LR
  P0["P0 基线与门禁"] --> P1["P1 叶子契约与配置"]
  P1 --> P2["P2 本地执行能力"]
  P2 --> P3["P3 Workflow 与工具宿主"]
  P3 --> P4["P4 Kernel 与 Node 分离"]
  P4 --> P5["P5 模型准入与应用入口"]
  P5 --> P6["P6 SDK 与最终收口"]
```

| 阶段 | 任务 | 交付单元 | 阶段结束条件 |
| --- | --- | --- | --- |
| P0（已完成） | T00 | 基线与可执行门禁 | 1,128 条现存关系精确登记；35 项边界测试与 141 项运行回归通过 |
| P1（已完成） | T01、T02 | 公共叶子数据；配置包 | 配置使用者不再因配置导入 core；旧路径删除 |
| P2（已完成） | T03 | execution-node | 本地进程/LSP 不再依赖 services；资源关闭不退化 |
| P3（已完成） | T04、T05、T06 | 定义/团队；WorkflowHost；工具工厂与 Jobs | 活动执行由实例宿主管理；工具没有后台运行目录 |
| P4 | T07、T08 | Kernel/Node 原子接口迁移；Engine 内部整理 | Kernel 源码和声明可达图隔离；默认 Node 能力仍可用 |
| P5 | T09、T10 | 显式模型准入；Server 应用入口 | 投影不做预算准入；路由不拥有持久业务流程 |
| P6 | T11、T12 | 依赖/公开面清理；SDK 与整体证据 | 本轮过渡例外为零，完整验收通过 |

优先顺序严格按图；T04/T05、T09/T10 在接口稳定后可分别形成提交，但默认顺序执行。T07 是跨 Kernel/Node/Server 的一个原子迁移组，内部小步骤不作为半完成架构合入主分支。

### 1.2 任务之间必须一致的接口

| 生产任务 | 输出 | 后续使用者 |
| --- | --- | --- |
| T01 | contracts 的 Message/Usage/失败身份/纯名称函数；现有错误 Symbol key 保持原值 | T02/T03/T07、api |
| T02 | host-config 的 Settings、路径、配置读写/锁；mcp 活体协调接口独立归 mcp | 所有宿主实现、T03/T05/T06/T07 |
| T03 | execution-node/executions、/lsp 明确出口；实例资源关闭 | T05/T06、Server BackgroundShell |
| T04 | coordinator/definitions 的唯一 AgentDefinition；coordinator/teams 的实例 TeamRegistry | 插件加载、Agent 工具、T05/T07 |
| T05 | 方案 5.5 的 WorkflowHost、WorkflowToolPort；文件 Repository；SQLite 适配保持原位 | T06、CLI、Jobs、Node 关闭 |
| T06 | createWorkflowTool(port)、createJobTools(host)、createTerminalTools(host)、createSkillTools(catalog)、createMcpTools(port) 和 Node 默认 registry | T07 的通用上下文与本轮准备 |
| T07 | PreparedAgentRun、AgentRunPreparation、DefaultNodeAgent.host、HostedAgent 和 Kernel 执行接口 | T08/T09、Server loader/pool/executor |
| T08 | 引擎具名内部模块；保持相同外部执行接口 | T09；不引入新的跨包依赖 |
| T09 | ModelAttemptGate；Server GoalModelAttemptService | 主生成/辅助模型调用、恢复与用量测试 |
| T10 | maintenance/facts/notes 窄应用用例接口 | HTTP routes、其他产品入口 |
| T11 | 最终依赖策略和实际公开出口 | T12 打包与总验收 |

## 2. P0：基线、行为保护和门禁

### T00：固定本轮迁移边界

**文件：**

- 修改：`scripts/architecture-boundaries.mjs`、`scripts/architecture-boundaries.test.mjs`。
- 新建：`scripts/architecture-policy.json`、`scripts/architecture-policy.schema.json`。
- 新建：`scripts/architecture-policy.mjs`，独立实现导入/声明来源解析和策略校验，避免继续扩大聚合入口。
- 新建：`docs/superpowers/reviews/2026-10-21-agent-package-convergence-baseline.md`，记录真实命令与结果。
- 读取：现有 package.json、SDK pack 脚本、方案第 10 节；不批量重写现有权威文档。

**接口：** 保留聚合命令 `node scripts/architecture-boundaries.mjs`；新增 `checkModuleDependency({ fromFile, specifier, importedNames, resolvedFile }, policy): string[]` 作为可测试规则入口。函数按包名、子入口、源码路径和导入符号判断，返回具体违规说明。

- [x] 写反例测试：Kernel 通过 Node 子入口、相对路径、类型导入或再导出读取 Node 内容都失败；HTTP route 从 services 根入口引入 SessionStore/Repository 也失败；正常 protocol 数据导入通过。
- [x] 对 AST 动态 import、require 和 import type 保留现有支持；补充已解析子入口和跨包相对路径测试。通过 barrel 导出的禁止类型也按声明可达图检查。
- [x] 把方案的目标依赖矩阵写成 policy；当前例外只能包含 `fromFile`、`target`、`reason`、`removeByPhase`、`migrationId`。本轮例外以当前源码事实逐项生成，不允许 `packages/**` 级通配放行。
- [x] 当前阶段推进时同步删除该阶段到期例外；CI 不允许用环境变量跳过规则。旧 store 调用计数收紧为 109，不拿它代替本轮目标检查。
- [x] 记录现有接口/行为基线：错误 Symbol key、ModelAttemptUsageStatus 为 complete/partial/unknown、Run/Child 回执顺序、Goal 尝试唯一键、两种 Workflow Repository 的 claim 能力、已授权应用不重复询问。
- [x] 执行以下命令并把退出码和输出摘要写入基线记录；全部通过。额外验证应用精确授权 2 项；实际命令及 worker 限制见基线记录。

```powershell
node --test scripts/architecture-boundaries.test.mjs
node scripts/architecture-boundaries.mjs
pnpm --filter @vykor/agent-runtime exec vitest run src/kernel.test.ts src/event-source.test.ts src/child-agent.test.ts src/plugin-app-policy.test.ts
pnpm --filter @vykor/server exec vitest run src/application/agent/__test__/daemon-agent-event-projector.test.ts src/application/session/__test__/session-run-executor.test.ts
```

边界反例的断言形式：

```js
assert.notDeepEqual(checkModuleDependency({
  fromFile: "packages/agent-runtime/src/kernel/agent.ts",
  specifier: "../node/configuration/index.js",
  importedNames: ["loadNodeConfiguration"],
  resolvedFile: "packages/agent-runtime/src/node/configuration/index.ts",
}, policy), []);
```

**验收：** A07；未来目标已有反例，现存代码只通过精确阶段例外。阶段完成时不声称目标结构已落地。

**实际进度：** 2026-10-21 完成 T00。35 项边界测试、67 项 Runtime、72 项 Server 和 2 项应用授权测试全部通过；聚合架构检查通过。P1 截止 490 条、P2 截止 3 条、P3 截止 11 条、P4 截止 580 条、P5 截止 13 条、P6 截止 31 条；后续只能随实际迁移删除，不重新生成白名单掩盖新增越界。

## 3. P1：拆出公共叶子数据和本机配置

### T01：先迁无宿主依赖的契约

**文件：**

- 新建：`packages/agent-contracts/package.json`、`tsconfig.json`、`src/index.ts`、`src/messages.ts`、`src/usage.ts`、`src/model.ts`、`src/errors.ts`、`src/tool-names.ts`、`src/context-usage.ts`、对应 `*.test.ts`。
- 修改：`packages/core/src/types/messages.ts`、`usage.ts`、`engine/model-retry.ts`、`utils/tool-names.ts`、`src/index.ts` 及真实使用者。
- 修改：新包消费方 package.json、`pnpm-lock.yaml`；按现有 workspace 模式配置，不另引发布框架。

**输入/输出：** M01/M04。先迁 Message、ContentBlock、UsageSnapshot、失败种类/错误、尝试身份/用量状态、ChildBudget 数据和纯工具名函数。ToolDefinition、StreamingMessageClient、AgentEvent 等存在上下文依赖的结构留到 T07，不能让新包反向引用 core 来提前搬空文件。

- [x] 迁移相关既有数据/错误/工具名测试；补新包无 Node/workspace 上层导入的反例。
- [x] 测试错误身份保留原全局 Symbol key，complete/partial/unknown 原样；消息压缩、工具失败标记字段不丢失。
- [x] 移动规范定义，更新 core 内部相对路径和所有消费者；删除已迁符号的旧 core 出口，不建立转发文件。
- [x] 删除已迁空文件：`types/messages.ts`、`usage.ts` 和 `utils/tool-names.ts`。
- [x] 运行数据契约、core 受影响测试及全仓消费者类型检查；P1 到期例外清零。

```powershell
pnpm --filter @vykor/agent-contracts test
pnpm --filter @vykor/core exec vitest run src/utils/message-history.test.ts src/engine/model-retry.test.ts src/context-budget
pnpm --filter @vykor/agent-contracts --filter @vykor/core --filter @vykor/api check-types
```

**验收：** A01 的已迁部分；M01/M04 的数据规范只有一个来源，错误身份不因搬迁变化。

### T02：迁出配置，并更新全部实际使用者

**文件：**

- 新建：`packages/host-config/` 的 package/tsconfig 和 `src/settings.ts`、`paths.ts`、`permissions.ts`、`environment.ts`、`hooks.ts`、`mcp-config.ts`、`mcp-credentials.ts`、`settings-mutation.ts`、`atomic-json-write.ts`、`git.ts`、`tool-configuration.ts`、入口与测试。
- 迁移：core `src/config/`、`types/settings.ts`、`types/mcp-oauth.ts` 中配置部分；Hook 配置数据类型；M02–M04。
- 新建：`packages/mcp/src/runtime-coordination.ts`，承接 ActiveMcpRuntimeHandle、Registry/Coordinator 等活体接口与当前默认 unavailable 实现。
- 修改：api/auth/permissions/hooks/sandbox/mcp/plugins/prompts/services/tools/terminal-node/agent-runtime/server/apps 的相关导入、package.json 和锁文件。

**接口：** 配置函数保留原参数、默认值、返回类型和文件路径。ApprovalMode/WorkMode 的跨端规范继续在 protocol；Settings 属于 host-config。请求超时默认值属于 api，重试算法属于 core。

- [x] 迁移 Settings、路径、文件锁、冲突恢复、MCP 配置校验测试；用临时目录覆盖用户/项目设置、并发保存和失败原子性。
- [x] 按导入符号分流：数据配置到 host-config，执行叶子数据到 contracts，活体 MCP 协调到 mcp。
- [x] 更新全部使用者；移除 core 的 loadSettings/getConfigDir/Settings 等配置出口。输出 token 限制归 host-config，api 请求超时默认值就地定义。
- [x] HookDefinition 归 host-config，执行事件/结果归 contracts；core 尚未缩小的 Hook 执行接口登记至 T07。
- [x] 工具名规范函数和配置退役校验分离；现有名称匹配/通配语义不变。
- [x] 运行配置测试和受影响消费者类型检查；实际源码不再从 core 引用配置符号。Sandbox 最终 44 项通过、2 项环境相关跳过，细节单独记录。

```powershell
pnpm --filter @vykor/host-config test
pnpm --filter @vykor/auth --filter @vykor/sandbox --filter @vykor/mcp --filter @vykor/permissions test
pnpm --filter @vykor/host-config --filter @vykor/api --filter @vykor/auth --filter @vykor/sandbox --filter @vykor/mcp --filter @vykor/agent-runtime --filter @vykor/server check-types
node scripts/architecture-boundaries.mjs
```

**验收：** A01 的配置隔离、M02/M03/M04；路径、锁和凭据格式与基线一致，未触碰用户真实文件。

**实际进度：** 2026-10-21 完成 T01、T02。新增 `agent-contracts`、`host-config`，MCP 活体协调接口归 `mcp/runtime-coordination.ts`；权限与 core 的跨包集成测试迁入 `agent-runtime/src/permission-schema.integration.test.ts`，继续由默认测试命令覆盖。架构阶段前移至 P1，例外由 1,128 条减少到 648 条（P1 0、P2 1、P3 9、P4 596、P5 13、P6 29）。未修改 P2 的进程或 LSP 所有权。详见 [P1 验证记录](../reviews/2026-10-21-agent-package-convergence-p1.md)。

## 4. P2：提取本地执行实现

### T03：从 services 提取 execution-node

**文件：**

- 新建：`packages/execution-node/package.json`、`tsconfig.json`、`src/index.ts`、`src/executions/`、`src/lsp/`。
- 迁移：services `src/executions/`、`src/lsp/` 及原测试；M05/M06。
- 修改：services 根/子入口与 package.json、tools 本地执行/LSP 引用、Server BackgroundShell/执行投影、CLI 执行使用者、SDK 构建依赖。

**接口：** 保持 DetachedProcessSupervisor、ChildAgentExecutionRegistry 和输出读取协议语义。增加显式 `ExecutionRuntimeOwner` 作为当前目录的实例所有者，其方法沿用当前 `getDetachedProcessSupervisor(scope)`、`getChildAgentExecutionRegistry(scope)` 的参数，并提供 `close(): Promise<void>`；目录 Map 从模块全局移入此实例。同一宿主中的使用者拿同一个实例，非宿主文件不能自行寻找默认进程单例。

- [x] 迁移进程/输出测试，新增 owner 隔离与关闭等待测试：相同 cwd/sessionId 的两个 owner 不互相关闭，重复获取复用实例，释放后新实例保留旧日志。
- [x] 搬迁进程、输出、LSP 和关联类型；必要的 8 个纯数据定义补迁至 contracts，execution-node 不反向引用 core。
- [x] 独立 Node 根 Agent 与 daemon 创建 owner；daemon 向 Node 工厂传入借用 owner。Jobs、BackgroundShell、LSP、Dream 和内存修改检查使用宿主显式传入的同一实例，删除模块级默认目录查找。
- [x] 保留真实子 Agent 的唯一生命周期控制者；ChildAgentExecutionRegistry 只观察执行和转交已有回调，关闭 registry 不负责停止真实子 Agent。
- [x] 更新动态导入、输出 helper 出口、依赖与已有测试；删除 services/executions 旧入口及原目录，不留转发。
- [x] 核对创建期间关闭、失败清理、stdout/stderr drain、超时中断、进程树结束、输出上限和 session 隔离；warm Agent 回收不关闭借用的 daemon 资源。

```powershell
pnpm --filter @vykor/execution-node test
pnpm --filter @vykor/server exec vitest run src/application/session/__test__/background-shell-service.test.ts src/application/session/__test__/session-execution-projector.test.ts
pnpm --filter @vykor/execution-node --filter @vykor/tools --filter @vykor/services --filter @vykor/agent-runtime --filter @vykor/server check-types
node scripts/architecture-boundaries.mjs
```

**验收：** A04/A06 的本地执行依赖部分；tools/runtime 不再为执行或 LSP 导入 services；同宿主资源可复用且关闭有明确归属。

**实际进度：** 2026-10-22 完成 T03 / M05、M06。新增 execution-node，`ExecutionRuntimeOwner` 持有实例目录、活动 LSP 请求和关闭过程；输出文件按 owner 与资源实例隔离。P1/P2 到期例外清零，剩余例外 619 条（P3 9、P4 571、P5 13、P6 26）。WSL 跨包测试移至 `tests/execution-node/`，由 `pnpm test:execution-integration` 和根测试命令覆盖。验证明细及未执行项见 [P2 记录](../reviews/2026-10-22-agent-package-convergence-p2.md)。

## 5. P3：Workflow、团队和工具宿主

### T04：Agent 定义归一与 Team 实例化

**文件：**

- 新建：coordinator `src/definitions/`、`src/teams/` 和 `/definitions`、`/teams` 正式出口。
- 迁移：agent-loader、agent-definitions、types 中 AgentDefinition、TeamRegistry 与测试。
- 修改：tools `src/agent/agent-tools.ts`、`team.ts`，plugins 的 Agent 加载、Node 扩展发现与默认能力；M07/M08。

**接口：** `AgentDefinition` 是唯一角色定义。`TeamRegistry` 保留 createTeam/deleteTeam/addAgent/sendMessage/listTeams 实例方法；`TeamPort` 为这些方法的窄结构接口。`createTeamTools(port)` 和 `createAgentTool({ definitions, teams })` 接受显式依赖。

- [x] 写两个 root 使用同名 team 的回归测试，断言彼此成员不同，删除一个不影响另一个。
- [x] 把用户目录解析从 coordinator 移到 Node；纯定义解析接收显式文件/内容，默认 builtin definitions 仍可直接读取。
- [x] Node 根树创建 TeamRegistry；所有递归 child 借用同一实例。插件 Agent 目录使用当前 runtime/run 捕获的定义，不回退进程注册目录。
- [x] 删除 getTeamRegistry 默认实例和 registerPluginAgents 全局注册入口；更新全部调用方。
- [x] 迁移定义解析/覆盖顺序测试；保留插件同名规则和 requiredMcpServers 校验，不顺便更改角色权限枚举。

```powershell
pnpm --filter @vykor/coordinator test
pnpm --filter @vykor/tools exec vitest run src/agent/__test__/agent-tools.test.ts src/agent/team-tools.test.ts
pnpm --filter @vykor/coordinator --filter @vykor/plugins --filter @vykor/tools --filter @vykor/agent-runtime check-types
```

**验收：** A05 的定义隔离、B04/B07 的团队/目录行为；同名角色不存在两份手写类型定义。

### T05：抽出 WorkflowHost 和文件 Repository

**文件：**

- 新建：coordinator `src/workflow/repository.ts`、`/workflow` 正式出口。
- 新建：agent-runtime `src/node/workflow/{workflow-host,file-workflow-run-repository,agent-workflow-runner,workflow-actions,workflow-presentation}.ts` 和测试。
- 迁移：coordinator store 的 M09–M11；tools Workflow runner/执行编排 M12；待等待适配 M13。
- 修改：`packages/server/src/application/workflow/session-workflow-run-repository.ts`、Node 默认能力、`apps/cli/src/commands/workflow.ts`。

**接口：** 使用方案 5.5 的 WorkflowHost/WorkflowToolPort，Host 暴露绑定 owner 的 jobs 视图；coordinator 只接收 WorkflowRunner、Repository 接口和取消/事件参数，不知道具体宿主。

- [x] 先建立文件/内存/SQLite 适配共用的测试场景：run、resume、history、timeline、cancel、父取消和 close；SQLite 测试继续位于 Server/services。
- [x] 拆 Repository 接口与快照 decoder，保持原文件格式；FileRepository 迁到 Node host，CLI 改用 Node Host 的正式出口。
- [x] 把活动运行 Map、后台执行 Promise、取消监听、run/resume/cancelPersistentWorkflow 迁到 Host 实例，移除 coordinator 全局活动目录。
- [x] 同一应用/Repository 只构造一个 Host，向 root/session 暴露 owner 视图；每次操作校验 owner，close 仅等待自己范围内的运行。
- [x] worker runner 使用现有 ChildController 和注入的 execution owner，Git 变更汇总留 Node；不再从 tools 动态导入全局执行目录。
- [x] 保持同步创建快照后才能返回 jobId 的约定。cancel 等待取消传播、worker 收尾和终态保存；保存失败不能返回完成。
- [x] 对跨进程互斥写清现有能力边界；本任务不增加新的 claim 格式、文件锁协议或数据库表。

```powershell
pnpm --filter @vykor/coordinator test
pnpm --filter @vykor/agent-runtime exec vitest run src/node/workflow
pnpm --filter @vykor/server exec vitest run src/application/workflow
pnpm --filter @vykor/coordinator --filter @vykor/agent-runtime --filter @vykor/server --filter @rzx/ohs check-types
```

**验收：** A05、B06/B07；文件/SQLite 两种宿主通过同一生命周期场景；coordinator 不读写文件、不维护活体运行目录。

### T06：工具变成窄调用，默认组装回到 Node

**文件：**

- 修改：tools `agent/workflow/tool.ts`、`job/job-tools.ts`、terminal/meta/skill/mcp/schedule 工具和各自入口/测试。
- 新建：tools `src/ports/` 下 Workflow/Skill/MCP/Schedule/配置等具名工具接口；已有 jobs/terminal 接口直接复用。
- 新建：agent-runtime `src/node/jobs/local-agent-job-host.ts`、`src/node/tools/default-tool-registry.ts`、具名能力工厂适配。
- 移动并删除旧路径：tools `job/local-job-host.ts`、`registry.ts` 的默认接线；M13/M14。
- 修改：agent-runtime 默认 Runtime、Server 工具注入、CLI 和 SDK 出口。

**接口：** 生产 T06 接口表所列工厂。WorkflowToolPort.invoke 的 input 使用只读参数，scope/取消由执行侧提供；不能让模型构造 host、Repository 或授权绑定。普通文件/Shell 工具可以继续使用 execution-node/sandbox，不能 import services。

- [x] 为 Workflow 工具写 port spy 测试：一次合法 action 只调用一次 invoke，传入真实 scope/signal，返回原有模型结果；工具返回后无自己的后台 Promise/监听。
- [x] 把 LocalAgentJobHost 移到 Node jobs，引用同一 WorkflowHost/ExecutionRuntimeOwner/ChildDirectory；模型 Job 工具只调用 AgentJobHost。
- [x] 为 Skill/MCP/Terminal/Schedule/Config 等工具增加工厂注入，先切换 Node registry 与调用方，旧 ToolContext 专用字段在 T07 删除。
- [x] 将默认工具开关、可信覆盖、注册来源及能力缺失规则搬到 Node registry。tools 只导出具体工具工厂，不再提供默认宿主组装。
- [x] 把 tools 对 auth/mcp/skills 实现包的导入改为 Node 注入的 port；不以 unknown/as 强转或通用服务字典代替。
- [x] 对缺失能力验证：不注册对应工具或返回既有 unavailable；不会静默启用本地默认实现。
- [x] 保留方法接收者和工具原定义 identity；工厂包装不能让当前基于 WeakMap/execute identity 的来源检查失效。

```powershell
pnpm --filter @vykor/tools test
pnpm --filter @vykor/agent-runtime exec vitest run src/node/jobs src/node/tools/default-tool-registry.test.ts src/default-runtime.test.ts src/inherited-tool-policy.test.ts src/capability-resolution.test.ts
pnpm --filter @vykor/tools --filter @vykor/agent-runtime --filter @vykor/server check-types
node scripts/architecture-boundaries.mjs
```

工具过滤的既有覆盖来自 `src/default-runtime.test.ts`、`src/inherited-tool-policy.test.ts` 和能力相关测试；默认 registry 的新接线断言放在新建 `src/node/tools/default-tool-registry.test.ts`。

**验收：** A04、B04/B06；工具层没有后台运行所有权，没有全局进程目录查找，注册来源与能力过滤保持有效。

**实际进度：** 2026-10-22 完成 T04–T06 / M07–M14。AgentDefinition 归一、Team 按根树隔离；WorkflowHost 拥有活动执行，文件仓库、worker 和默认工具组装迁到 Node；工具使用显式能力接口。修复关闭顺序，真实 child 收尾后才移除。架构阶段推进到 P3，例外 597 条（P4 558、P5 13、P6 26），P0–P3 到期例外为零。1,112 项测试通过、1 项 Windows 不适用测试跳过，类型、构建、正式入口及检查结果见 [P3 记录](../reviews/2026-10-22-agent-package-convergence-p3.md)。后续 P4 结果见下一节。

## 6. P4：Kernel 与 Node 分离

### T07：原子迁移执行契约、通用上下文和宿主能力

**文件组：**

- 新建/完善：contracts `tools.ts`、`tool-data.ts`、`execution.ts`、`events.ts`、`children.ts`、`permissions.ts`、`hooks.ts`。
- 新建：agent-runtime `src/kernel/`；Node `runtime/`、`configuration/`、`capabilities/`、`plugins/`、`plugin-apps/`、`memory/`、`mcp/`、`review/`。
- 新建：Server `src/application/goals/{goal-run-contribution,goal-read-tool,goal-update-tool}.ts`；`application/agent/tool-app-origin-projector.ts`。
- 修改：core QueryEngine/checked execution/permissions 和 `/engine`、`/context-budget` 正式出口；protocol MCP 通用数据来源；SDK 两个入口/构建；Server loader/pool/run executor/应用操作；相关全部测试。
- 新建：host-config `src/tool-output-policy.ts`，接收原工具 inline/preview 输出和超时环境变量解析；core 保留裁剪/超时执行算法并改用显式参数。
- 迁移清单：M15–M22、M30–M33。通用集合封装迁到 contracts `collections.ts`；旧文件和旧 core/Agent 出口在同一迁移组删除。

**接口：** 方案 5.1–5.4。产出精简 VykorAgent、DefaultNodeAgent.host、HostedAgent、PreparedAgentRun 和 AgentRunPreparation。Engine 保留通用执行入口和 ModelAttemptGate 类型，实际 Goal gate 在 T09 安装；T07 阶段仍由已有 projector 记账。

本任务分四个编辑步骤，但必须作为一个可构建、可运行的整体交付：

- [x] **T07.1 固定测试。** Kernel 只接收 fake client、工具、环境、effects；依赖反例阻止 Node 专属类型进入 Kernel 声明。迁移 B01–B05 测试，不删除现有失败/取消用例。
- [x] **T07.2 缩小通用上下文。** 移走 Settings/MCP/Skill/Terminal/Jobs/Schedule 字段，切到 T06 工厂；把通用消息/工具/事件/控制类型移入 contracts。NodeCapabilityView 保留具体能力目录，PreparedAgentRun 只携带捕获的通用执行绑定。
- [x] **T07.3 分开宿主和生命周期。** Kernel 使用引擎执行接口及显式 release；RuntimeBundle/RuntimeBuilder 迁成 NodeRuntimeResources。Child 工厂只接收已解析配置，保留创建/幂等/TTL/关闭状态机。Node 负责资源安装/本轮准备，清理发生在准备失败、终态和 close 三条路径。
- [x] **T07.4 搬走 Goal 和应用接入并切换使用者。** Server 创建 Goal contribution；Node host 管应用 catalogue/lease；Server 经通用独立工具执行入口调用已捕获工具。应用精确确认走宿主通用确认接口，硬 deny 仍优先。持久 pluginAppOrigin 在可靠 Server 入口生成。
- [x] 更新 Server HostedAgent 适配、loader/pool/self-review、SDK 调用者和声明；Node 默认工厂仍直接提供 submitMessage/runMessage/close，host 特性只从 `.host` 访问。
- [x] 删除内核中的 Goal/PluginAppRecord/插件候选策略、完整 Settings 和默认能力创建代码；更新构建入口与 metafile 检查。
- [x] 完整运行该原子组的相关回归后，再交付此阶段；禁止只合入新 interface、留双运行路径。

必须验证的具体场景：

| 输入/安排 | 触发 | 必须断言 |
| --- | --- | --- |
| 已冻结插件工具随后被撤销 | 准备后启动 root/child | 受影响 Provider/工具调用次数为 0，回执失败 |
| subscribe 监听器抛错 | 普通成功 Run | result 仍成功，可靠 sink 记录完整 |
| 终态 sink 等待可控 Promise | 等待 run.result | Promise 释放前 result 未完成，释放后才完成 |
| 保存的应用授权与工具 identity/参数/revision 完全匹配 | 独立工具调用 | 不重复询问，仍执行普通检查管道 |
| 结果 metadata 伪造应用 origin 或批准字段 | 工具完成/再次调用 | 不生成可信 origin，也不绕过确认 |
| 父 Run 只允许工具 A，child 请求 A/B | 启动 child | B 不进入实际工具集合，父权限上限未改变 |

由各测试的 fake Provider、可控 sink、授权 port 和父子工具集合记录结果，不添加生产计数器。P0/T07 测试 fixture 使用可控 Promise，避免依靠任意 sleep 判断先后顺序。

```powershell
pnpm --filter @vykor/agent-contracts test
pnpm --filter @vykor/core test
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/server exec vitest run src/application/agent src/application/session/__test__/session-run-executor.test.ts src/application/session/__test__/session-plugin-run-authorization.test.ts src/application/session/__test__/session-plugin-app-action.test.ts src/permissions
pnpm --filter @vykor/protocol test
pnpm check-types
node scripts/architecture-boundaries.mjs
```

**验收：** A01–A04、B01–B05；Kernel 的源码/声明/运行构建均不含宿主功能；Node 默认能力和持久应用协议行为一致。

### T08：按执行阶段拆 QueryEngine，保持一个历史所有者

**文件：**

- 新建：core `engine/model-attempt-runner.ts`、`tool-execution-context.ts`、`turn-context.ts` 及必要的测试。
- 修改：`engine/query-engine.ts`、`buffered-model-retry.ts` 和现有相关测试；M23。

**接口：** QueryEngine 保留 public submitMessage/executeTool/getHistory/compact；内部 model-attempt-runner 只执行一次模型尝试并汇总事件，turn-context 生成本回合冻结输入，tool-execution-context 从显式执行参数生成通用 ToolContext。可复用既有 checked-tool-execution，不再造第二条工具管道。

- [x] 用既有回归固定模型失败后重试、部分输出替换、工具提交一次、steer 边界和末轮收尾行为。
- [x] 将对应代码搬入具名模块，通过参数/返回值交换结果；QueryEngine 唯一持有可变消息历史和当前请求配置。
- [x] 不把 Engine 所有字段打包成内部万能 EngineContext，也不让子模块持有另一份 history/cost 状态。
- [x] 保留批次取消与已启动工具的独立结果交付；新模块不重试工具执行。
- [x] 移动测试而非重复同一实现断言；对新发现的交叉状态才增加用例。

```powershell
pnpm --filter @vykor/core exec vitest run src/engine/model-retry.integration.test.ts src/engine/buffered-model-retry.test.ts src/engine/checked-tool-execution.test.ts src/engine/recovery-evidence.test.ts src/engine/tool-discovery.integration.test.ts src/engine/request-configuration.test.ts
pnpm --filter @vykor/agent-runtime exec vitest run src/kernel
pnpm --filter @vykor/core --filter @vykor/agent-runtime check-types
```

**验收：** B01/B02/B04；一个历史所有者、一条受检查的工具执行管道；不以每个文件小于某行数作为验收。

**实际进度：** 2026-10-22 完成 T07、T08。执行契约归 contracts，Kernel 只接收通用 Engine、捕获工具、effects 和 release；具体能力归 Node.host，Server 持有 HostedAgent 并生成可信来源，Goal contribution 迁入 Server。QueryEngine 拆出单次模型尝试、冻结请求和工具上下文，保留唯一历史和工具检查管道。架构例外降至 39 条（P5 13、P6 26）；类型检查 67/67，通过正式构建和打包消费者验证。测试首轮及补验、资源所有权和后续边界见 [P4 验证记录](../reviews/2026-10-22-agent-package-convergence-p4.md)。

## 7. P5：显式模型准入和 Server 用例

### T09：从事件投影移出 Goal 尝试准入与记账

**文件：**

- 新建：Server `application/goals/goal-model-attempt-service.ts` 及 `*.test.ts`。
- 修改：core 主模型/辅助模型尝试入口、Node 记忆/压缩/插件选择调用；Server session-run 组装、projector 和现有 Goal 用量/恢复测试。
- 迁移：M24；保留 services GoalOperations 和当前表/唯一键。

**接口：** 方案 5.6 的 ModelAttemptGate.beforeDispatch/settle；Server 服务只接受来自宿主 scope 的 run/session 身份，对接 beginGoalModelAttempt/recordGoalModelAttempt。usageStatus 固定为 complete/partial/unknown，未发出使用 notDispatched 标记。

- [x] 先写失败测试：预算拒绝时 Provider 调用为零；同一尝试重复 settle 用量只增加一次；projector 重放不写 Goal 用量。
- [x] 写时序测试：beforeDispatch 阻塞时客户端调用为零；准入后事件 sink 失败或取消会登记未发出；实际网络调用后用量缺失保留 unknown。
- [x] 实现 GoalModelAttemptService，复用现有事务和归属校验；每次重试使用同 generationId、递增 attempt。
- [x] 同一提交切换所有模型入口并删除 projector.projectGoalUsage 的准入/记账职责；不要并行保留两条写入路径。
- [x] 主生成、compaction、finalization、memory、plugin_selection 都在第一条网络请求前经过 gate，辅助重试同样如此。
- [x] 结算失败阻止成功返回，交给持久恢复；终态重复、父子归属、Goal 版本变更、审批等待/暂停、未知用量恢复使用既有规则。
- [x] 明确自动审查等独立辅助调用继续按当前归属执行，不创建虚假的父 Run；不将预算拒绝包装成模型网络重试。

```powershell
pnpm --filter @vykor/core exec vitest run src/engine/model-retry.integration.test.ts src/engine/buffered-model-retry.test.ts src/engine/goal-context.test.ts
pnpm --filter @vykor/agent-runtime exec vitest run src/node/memory src/node/plugins
pnpm --filter @vykor/services exec vitest run src/goals
pnpm --filter @vykor/server exec vitest run src/application/goals src/application/agent/__test__/daemon-agent-event-projector.test.ts src/application/session/__test__/session-goal-service.test.ts src/application/session/__test__/session-goal-dispatch-events.test.ts
pnpm --filter @vykor/core --filter @vykor/agent-runtime --filter @vykor/services --filter @vykor/server check-types
```

**验收：** B08/B09；模型准入与记录错误来源明确，任何网络调用都不绕过登记，回放不产生双记账。

### T10：maintenance/facts/notes 收口到应用用例

**文件：**

- 新建：Server `application/maintenance/maintenance-application-service.ts`、`maintenance-policy-repository.ts`；`application/personalization/project-facts-service.ts`；`application/notes/note-application-service.ts`。
- 修改：`http/routes/maintenance.ts`、`facts.ts`、`notes.ts`、HTTP 上下文、DaemonApplication 和相关测试；M25–M27。
- 保留：现有 backup/cleanup/usage 专项实现，不复制第二份算法。

**接口：** 路由 context 只声明其使用的用例方法；应用接口返回业务数据，抛结构化应用错误，不返回 HTTP Response。维护用例有 getStorageHealth/getRestartPreview/prepareRestart/readPolicy/updatePolicy/runCleanup/readUsage/updateUsageSettings 及现有备份/导入导出动作；精确方法清单从当前路由一对一列入任务 diff。

- [x] 先保留请求级测试：未 ready 写入拒绝、活跃任务拒绝重启、路径/预期版本冲突、事实脱敏、session/cwd 不匹配、便签 revision 冲突。
- [x] 把文件位置、read/write/锁/close 编排移到应用/Repository。路由保留 parse/readJson/状态码转换，不读取 Store.path 或保存策略文件。
- [x] 将 ready/owner/cwd lease 获取点写入各用例；维护重启按基线释放当前 lease 后等待 application close，避免自己等待自己。
- [x] Note 应用层直接持有必要业务用例和错误映射，若只需结构约束，使用应用层声明的窄接口，避免创建无规则的逐方法转发类。
- [x] DaemonApplication 注入服务，并把大型领域闭包转成具名组装函数；不得把路由搬走的实现粘进构造函数。
- [x] 对 route 根入口和类型 alias 写 AST 反例，移除 P5 例外。

```powershell
pnpm --filter @vykor/server exec vitest run src/application/maintenance src/application/personalization/facts.routes.test.ts src/http/routes/notes.test.ts src/application/personalization src/application/notes
pnpm --filter @vykor/server check-types
node --test scripts/architecture-boundaries.test.mjs
node scripts/architecture-boundaries.mjs
```

**验收：** A06、B10；返回/错误和写入互斥与基线一致，路由中没有持久业务实现。

**实际进度：** 2026-10-22 完成 T09、T10 / M24–M27。Goal 准入与记账由显式服务执行，投影只保存事实；主/辅助模型调用先准入再发出，结算错误不进入重试或压缩兜底。维护、事实和便签业务归应用服务，HTTP 只做接入。Core 438 项、services 575 项及 Server/Node 定向回归通过，类型 67/67、构建和打包安装通过；架构剩余 25 条均属于 P6。P4 已提交为 63c46b00，P5 尚未提交。验证细节见 [P5 记录](../reviews/2026-10-22-agent-package-convergence-p5.md)。

## 8. P6：依赖、SDK 和证据收口

### T11：消除阶段例外和残余旧公开面

**文件：**

- 修改：各 package.json/exports、源码入口、architecture policy/baseline/tests。
- 检查并按证据清理：core AppStateStore、coordinator 纯包装/全局注册、themes/terminal-node 等已经不再需要的依赖、swarm 的内部和发布用途；M28/M29。
- 存储规则：services database/各 Repository/session-runtime 和宿主辅助子域的模块策略。

- [ ] AST 扫描所有静态、类型、动态、再导出和跨包相对路径；逐项对照方案包矩阵和 Kernel/存储子模块规则。
- [ ] 删除到期例外，不把它们改成长期允许边。P6 结束 `stageExceptions` 为空。
- [ ] 对 AgentDefinition、工具数据、Settings、错误身份确认唯一规范来源；删除旧 core 配置出口、tools 宿主默认出口和旧 Node 文件转发。
- [ ] 清理没有实际引用的 package.json 依赖；测试依赖单独声明，不能借 dev/peer 依赖隐藏反向边或循环。
- [ ] 对 swarm/公开出口区分仓库内使用与已发布承诺：无发布/消费证据则保留独立用途并记录，不把“仓库内零引用”当作删除外部包的依据。swarm 不参加当前 Agent 执行链。
- [ ] 保持 services 的 Office/Memory 子域可用，存储模块不可导入它们；本轮不再追加 Office/Memory 全面重写。

```powershell
node --test scripts/architecture-boundaries.test.mjs
node scripts/architecture-boundaries.mjs
pnpm check:client-api
pnpm check:clean-slate
pnpm check:retired-ui
```

**验收：** A01–A07；既有合法能力保留，本轮旧实现入口和阶段放行均清零。

### T12：SDK、权威文档和最终整体验收

**文件：**

- 修改：agent-runtime `scripts/build.mjs`、`scripts/verify-pack.mjs`、声明构建/公开面测试、SDK package.json、锁文件。
- 修改：`docs/architecture-overview.md`、`agent-framework-capability-boundary.md`、`agent-runtime-framework-architecture.md`、`agent-sdk.md`、`daemon-application-architecture.md`、`session-runtime-storage-architecture.md`、`contract-test-index.md`、`architecture-migration-status.md`、`docs/README.md`、根 README。
- 修改：`docs/vykor-current-architecture.architecture.json` 及现有架构图生成产物；仅在实际代码迁移完成后更新“当前实现”。
- 新建：`docs/superpowers/reviews/2026-10-21-agent-package-convergence-closeout.md`。

**接口：** SDK root/Kernel 两入口保持正式路径；root 返回 DefaultNodeAgent，Kernel 返回精简 VykorAgent。独立消费者显式使用新接口，不依赖工作区源码或旧 core 导出。

- [ ] esbuild 生成 Kernel/default 两份 metafile；检查 Kernel 源码输入和声明可达图，禁止 Node 组装/数据库/PTY/Goal/应用记录进入 Kernel。
- [ ] 将新内部包加入现有声明/pack 闭包；保留 native tool host-entry 和默认入口依赖。逐项核实 better-sqlite3/sharp 真实可达性后才决定删除 SDK 依赖。
- [ ] 用仓库外临时安装的 tarball 验证 fake Provider 的 root、child、事件、关闭和跨 bundle 错误身份；默认入口继续验证 Native Tool 和必要 PTY。
- [ ] 更新 SDK 示例、CLI Workflow 文件操作、Node host API 和权威架构文档；删除旧 API 文案，不把历史方案改写成已实现记录。
- [ ] 更新 contract-test-index，逐项映射 A01–A07/B01–B11 到具体测试和命令。
- [ ] 运行以下最终检查，记录退出码、环境限制和失败处置。这里会重复覆盖部分阶段测试，仅最终整体收口执行一次；无新失败不再反复重跑。

```powershell
pnpm check-types
pnpm check:architecture
pnpm test
pnpm --filter @vykor/agent-runtime test:pack
pnpm test:client-browser
pnpm check-docs
```

**验收：** B11 和所有 A/B 条目；独立 SDK、Server、Client 和文档描述一致；不把“构建成功”替代模型/子 Agent/取消/权限等行为验收。

## 9. 验收证据矩阵

下列目标测试路径若尚不存在，由对应任务创建；现有测试按迁移后的实际位置更新，不能只把旧测试文件名写进表中视为完成。

| 标准 | 主责任任务 | 自动化证据 |
| --- | --- | --- |
| A01 | T01/T02/T07 | 新包测试、类型导入图、无 Node/反向依赖反例 |
| A02 | T07/T08 | core AST 边界、无宿主字段的类型消费测试 |
| A03 | T07/T12 | Kernel 源码/声明可达图、metafile、独立 pack |
| A04 | T03/T06 | tools 依赖反例、port spy、ExecutionRuntimeOwner 隔离 |
| A05 | T04/T05 | coordinator 子模块反例、Host.close/实例隔离测试 |
| A06 | T10/T11 | route 使用例、存储反向依赖反例 |
| A07 | T00/T11 | architecture policy 反例、循环依赖与零阶段例外 |
| B01 | T07/T08 | Run 输入/互斥/steer/interrupt 既有测试 |
| B02 | T07 | 可控 sink 的 started/result 顺序及失败测试 |
| B03 | T07 | ChildManager 创建/幂等/TTL/关闭及树目录测试 |
| B04 | T04/T06/T07 | 插件撤销/升级/父子缩权、来源与工具描述不授权 |
| B05 | T07 | 应用精确确认、硬 deny、无重复询问、伪造 origin |
| B06 | T05/T06 | 文件/SQLite Workflow 的 run/resume/cancel/close |
| B07 | T03/T04/T05 | 同名团队、跨 owner/Repository 隔离、关闭范围 |
| B08 | T09 | 各模型 purpose/重试前置 gate、拒绝零 Provider 调用 |
| B09 | T09 | notDispatched、unknown、重复结算、父子归属和崩溃恢复 |
| B10 | T10 | maintenance/facts/notes 请求级回归与 lease 顺序 |
| B11 | T12 | 独立 tarball、native tools/PTY、浏览器 client 构建 |

## 10. 每阶段交付记录与回退

每个阶段追加一条实际记录，字段固定为：阶段/任务、提交身份、迁移编号、改变的正式接口、执行命令及退出码、A/B 证据、保留到下一阶段的精确例外、失败和回退点。没有运行的命令写“未运行”并说明原因，不填写推测结果。

回退范围：P1 配置与其使用者一起退；P2 execution owner 与所有使用者一起退；P3 Host/工具/CLI/Jobs 组装一起退；P4 整个接口迁移组一起退；P5 gate 启用与 projector 分支删除一起退。SQLite/文件格式保持不变，因此正常代码回退不要求用户删除或重建数据。

如果发现必须改持久字段、协议格式或扩大预算统计语义，停止该附加变更并先补独立设计；已授权的本阶段其他职责迁移可以继续。没有实际完成的阶段保持未完成，不因预算、时间或文档已写完而勾选。
