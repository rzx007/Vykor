# Agent Framework Capability Boundary

> 状态：当前架构约束。代码与本文冲突时，应先修改所有权设计，不新增 compatibility adapter。

## 一句话边界

```text
framework 管执行、live state 与 live handles
daemon 管 durable session/task/run/transcript projection 与多客户端策略
surface 管交互和展示
```

```mermaid
flowchart LR
  Framework["agent framework<br/>execution + events/effects/handles"]
  Daemon["daemon application<br/>HTTP + durable projection + coordination"]
  Surface["TUI / Web / Desktop / CLI"]

  Daemon --> Framework
  Surface --> Daemon
  Surface -. programmatic mode .-> Framework
```

真实依赖方向：

```text
@vykor/core <- @vykor/agent-runtime <- @vykor/server <- clients/apps
```

Kernel 禁止依赖 server、HTTP、SSE、daemon store、产品领域记录以及 domain-contracts、plugin-contracts、json-data；纯数据包也不能因此进入 Kernel。Node 从 plugin-contracts 和 Job/Terminal contracts 消费自身需要的数据，不依赖 Protocol、domain-contracts 或 Services，不读取数据库，不拥有 Goal 状态。

## Kernel 与默认 Node 组装

`agent-contracts` 定义跨包执行数据；`core/engine` 负责模型与工具循环；Kernel 负责 Run/Child 状态和可靠事件交付。Node 在进入循环前捕获本轮工具和能力，通过 `AgentRunPreparation` 返回通用绑定与释放函数。完整 Settings、插件/Skill/MCP/Jobs/Terminal/Schedule 由具体工具工厂闭包持有，不能塞回 `ToolContext`。

Server 保存 `HostedAgent { agent, host }`：执行通过 agent，插件/配置/记忆/检查通过 host。GoalRead/GoalUpdate 与目标提示词由 Server 组成通用 contribution。应用工具仍走 Kernel `runTool` 和同一条受检查执行管道；精确确认由 Node 校验保存的授权、参数、版本与工具身份，硬 deny 优先。可信应用来源由 Server 和 Node 从本轮真实捕获的绑定生成，不信任工具结果或事件自由字段。Server 验证持久应用状态与 revision 后，用 `pluginAppHostBinding()` 构造插件、版本、digest、后端和 owner 数据，连同 lease、工具名、参数交给 Node。绑定保留不透明 `instanceId = app.id` 用于隔离和撤销，不携带可变应用记录或 Run 账本。Node 保留原 lease 权威和二次绑定检查，Server 适配它，不另建第二份 token 表。

Node 的能力捕获目录属于根树实例，子 Agent 借用；不设置进程级运行目录或通过全局工具 ID 反查宿主。通用 `profile.toolResultReferences` 仅选择结果引用策略，Node 根据已授权范围配置，Kernel 不据此发现插件。

`@vykor/agent-runtime` 现在有两个入口，名字代表它们会做多少事：

| 入口 | 实际做什么 |
|---|---|
| `createAgentKernel()` | 只运行 Agent/Run/Child；只接收执行引擎、通用工具绑定、effects 和 prepare/release |
| `createDefaultNodeAgent()` | 读取本机配置并组装 provider、工具、插件、Skill、MCP、Memory、Sandbox 和 Git child environment |

`createVykorAgent()` 已删除，不提供兼容别名。调用方必须明确选择最小 Kernel 或 Node 默认组装。

能力归属清单：

| 能力 | 放在哪里 | 原因 |
|---|---|---|
| Agent/Run/Child 状态、event/effect/handle、关闭 | Kernel | 这是一次 Agent 执行本身 |
| QueryEngine turn loop | core；Kernel 接收引擎接口 | Kernel 使用它，但不替宿主选择 provider |
| `StreamingMessageClient` 接口 | agent-contracts | 可以用 fake client、远程 client 或 Node client |
| Anthropic/OpenAI/Codex client | 默认 Node 组装 | 会处理真实网络端点和凭据 |
| settings 和 CredentialStorage | 默认 Node 组装 | 会读取本机和用户目录 |
| 插件、Skill、MCP、Memory | 默认 Node 组装 | 会发现或连接外部资源 |
| Sandbox、process exit cleanup、Git worktree | 默认 Node 能力 | 都依赖具体操作系统环境 |
| Permission effect | `effects.requestPermission` | 宿主交互副作用；未提供时默认拒绝 |
| Terminal、后台 Shell | `capabilityOverrides` | 接受 Host `{ value, jobs }` bundle，逐项替换或关闭；Kernel 不创建 Node 备用实现 |
| child environment、Workflow repository、Schedule | `capabilityOverrides` | 接受 Host 对象，或用 `false` 逐项关闭 |
| Jobs、Memory | `capabilityOverrides` | 只接受 `false`；不能传入 Host 对象替换 |
| 附件读取、图生文、文生图 | daemon Tool 组装 | 默认 Agent 和 `@vykor/tools` 都不提供视觉 Tool；daemon 完整定义视觉 Tool，并通过统一的 `tools(context)` 动态注册 |
| HTTP、SQLite、SSE、durable Session/Run | Durable Application | 这是多客户端和进程重启后的状态 |

Kernel 的硬规则：

- 不调用 `loadSettings()`；
- 不创建 `CredentialStorage`；
- 不发现插件、Skill 或 MCP；
- 不启动 Sandbox；
- 不写 `process.stderr`；
- 不创建 `createNodeJobBindings`；
- child 的通用限制由 Kernel 收紧；Node 为整棵树解析宿主能力，借用资源不能由 child 关闭；
- 没有显式 child environment 时只沿用 cwd，不查 Git、不建 worktree。

可传入 Host 对象的 override 是 `terminal`、`backgroundShell`、`childEnvironment`、`workflowRepository` 和 `schedules`；Terminal 与后台 Shell 都使用 `{ value, jobs }`，确保其 Job 可观察。`jobs` 与 `memory` 只能设为 `false`，分别禁用本地 Jobs 或受管 Memory，不能用 Host 对象替换。若设 `jobs: false`，还必须同时设 `terminal: false`、`backgroundShell: false`、`childEnvironment: false` 和 `workflowRepository: false`，因为这些能力会产生或依赖 Job。权限通过 `effects.requestPermission` 提供。Artifact 与更细的 Workspace 操作还没有稳定接口，因此本阶段没有添加两个只占名字、不能工作的空对象；以后出现真实调用方时再加入。

附件与视觉能力走 Tool 扩展边界：`DefaultNodeAgent` 保留纯本地 `Read`，默认 Registry 不注册 `ImageToText` 或 `ImageGeneration`，`@vykor/tools` 也不定义或导出它们。daemon 用第一方可信 `Read` 覆盖处理授权附件，在 server 内完整定义图生文与文生图 Tool，并通过 `createDaemonAgentLoader.tools(context)` 注册。附件存储、Child → Root 授权、本地 OCR 和附件 compact 文案都留在 server。core 和 agent-runtime 只看到 ToolDefinition 与通用 compact 章节，不看到附件类型。

## 发布形式

公开 SDK 入口是 `@vykor/agent-runtime`；内部包随声明依赖安装，不承诺独立可替换实现。发布包提供三个路径：

```text
@vykor/agent-runtime          默认 Node 入口
@vykor/agent-runtime/kernel   Kernel、通用执行工厂和显式类型
@vykor/agent-runtime/node/workflow  Node Workflow 宿主与仓库
```

构建结果在 `dist`，`main`、`types` 和 `exports` 不再指向 TypeScript 源码。Kernel ESM bundle 不需要仓库源码就能运行；完整入口也会生成可直接加载的 ESM bundle。workspace 包作为公开声明所需的正式依赖，`pnpm pack` 会把发布清单中的 `workspace:*` 转成正常版本号。

esbuild 把 api/auth/core/tools/mcp/plugins 等实现打进 `dist/`。消费者安装的内部依赖用于公开声明，不用于替换 bundle 内的实现。默认入口保留 sharp、node-pty 与 Native Tool host-entry，数据库驱动不在执行闭包中。

`pnpm run test:pack` 每次都会：

1. 重新生成 JavaScript bundle 和声明文件；
2. 创建 npm tarball；
3. 检查 tarball 的 manifest 不含 `workspace:`；
4. 安装到仓库外的临时目录；
5. 用 TypeScript 消费 Node/Kernel/Workflow 的公开声明；
6. 用 fake Provider 跑 root/child、事件、幂等关闭、关闭后拒绝及跨 bundle 错误识别；
7. 实际启动 Native Tool 和默认 PTY/Job。

## Framework 边界

Kernel 负责：

- 使用宿主已经准备好的 runtime、model、tools 和 hooks
- history、usage、当前 run 与资源生命周期
- 单实例 `idle/running/maintaining/closing/closed` operation state machine
- permission wait 的执行语义
- child identity、实例、递归执行、tree-wide descendant directory、follow-up、interrupt、suspend/resume 和宿主提供的环境 lease
- 有序 reliable `onEvent`、隔离 `subscribe`、permission effect 和 run/child handles
- compact、remember、inspect 等 Agent 操作；没有 Memory 能力时 `remember` 明确跳过

默认 Node 组装负责：

- provider client、默认工具和 prompt；
- settings、凭据、插件、Skill、MCP 和 Memory；
- Sandbox 和进程退出清理；
- 选择 Git worktree child environment；
- 安装本地 Terminal、Jobs、后台 Shell、Memory、Workflow repository 和默认 child environment；
- 对每个未覆盖的能力保留它自己的默认值；Attachments 与 Schedules 在没有 Host 覆盖时为 unavailable；
- 释放 runtime 自己创建的默认资源；Host 覆盖是借用对象，必须支持 root session tree 且始终由 Host 自己释放。

framework 不负责：

- durable session/input/run/message/task schema
- HTTP route、Bearer auth、SSE 或多客户端 permission prompt
- daemon restart recovery、archive、rewind、export
- 每 session 的多请求 queue policy

## Daemon 边界

daemon 负责：

- root prompt durable admission 与 per-session run lane
- 每个 pool-owned session 的 warm agent cache
- 实现 `requestPermission` callback
- 每个 root agent 注入一次可靠 `onEvent` sink
- 把 `AgentEvent` 单向归约为 durable transcript/run/task/session/event 和 SSE
- 把 HTTP/task commands 路由到 framework-owned run/child handles
- restart recovery、maintenance 与 product APIs
- session/cwd/global admission barrier 与 daemon stop-and-drain

daemon 可以保存 `rootAgent + childId` 的路由索引，但不复制 child controls，也不拥有 child instance。

## 状态归属

| 状态 | 唯一所有者 |
|---|---|
| agent history / usage / model loop | framework |
| active run、steer queue、abort | framework |
| run started/terminal delivery barrier | framework |
| child instance / handle / worktree lease | framework |
| durable session/input/run/transcript | daemon |
| durable permission request/reply | daemon |
| durable child session/task/run | daemon |
| per-session request lane | daemon |
| warm root agent cache | daemon `AgentPool` |
| 单 agent operation 互斥 | framework `VykorAgent.state` |
| session/cwd/global 请求互斥 | daemon `DaemonOperationGate` |
| UI selection/render/prompt controls | surface |

## 边界协议

```text
framework -> daemon : ordered AgentEvent facts through onEvent
framework -> daemon : requestPermission call when a result is required
daemon -> framework : run.steer / run.interrupt / child.send / child.interrupt
```

事件绝不携带 live capability。effect 绝不兼任 telemetry。handle 绝不写入 durable store。

## 扩展判断

1. programmatic agent 是否也需要？需要则优先进入 framework。
2. 是否必须等待外部返回值？是则定义窄 callback/effect。
3. 是否只是已发生事实？是则扩展 `AgentEvent` union，并由 `onEvent`/`subscribe` 消费。
4. 是否控制 live execution？是则扩展 handle。
5. 是否操作 HTTP、SSE、durable schema 或多客户端策略？是则进入 daemon。
6. 是否只影响 TUI/Web 的交互与渲染？是则留在 surface。

## 已退场抽象

以下名称不应恢复：

```text
SessionRuntime / AgentSessionRuntime / RuntimeFactory
AgentRunHost / QueryRuntimeHost / ToolRuntimeHost
DaemonRuntimeHostPort / DaemonRunProjection
AgentChildProjection / DaemonChildAgentProjection
ChildAgentProjectionFactory / LiveChildAgentRegistry controls copy
pullFollowUps / wakeCount / mergeWake
```

P5 中，Server 通过 GoalModelAttemptService 在实际模型请求前准入、完成事实发布前结算；Node 仅传递通用 gate，事件投影不写 Goal 账本。维护、事实和便签路由调用应用用例，文件位置、写入就绪检查与独占凭证留在应用层。

## P6 与 Protocol 收敛后的长期边界

架构门禁覆盖静态/类型/动态导入、再导出、别名、跨包相对路径与声明来源。当前阶段为 P13，`stageExceptions` 为空；[P7 基线](./superpowers/reviews/2026-10-22-protocol-layering-baseline.md) 的 4,173 条关系是迁移前历史快照，不是当前例外数。底层能力、Services、Node 和 Server application 不再依赖 Protocol。Client 只直接依赖 Protocol，Server/Client 联合测试放在 `tests/server-client`。存储模块仍不能导入 Office/Memory 辅助宿主、模型、进程和 PTY；宿主辅助域保留原能力。

AgentDefinition 的规范来源为 coordinator/definitions，执行权限与审查数据归 agent-contracts/permissions，工具数据与执行错误归 agent-contracts，Settings 与旧模式归一化归 host-config，有效权限计算归 permissions。领域记录归 domain-contracts，插件清单与后端绑定归 plugin-contracts，通用 JSON 归 json-data/json；Job/Terminal 的纯数据从各自 /contracts 引用。旧 Core 配置、工具默认宿主与 Node 转发入口不保留。旧 Swarm 包已退役，团队登记属于 Coordinator 的 TeamRegistry，实际执行由 Node 宿主和 Kernel child 管理。


阶段 A 已接通 Jobs 协议 6 与共同执行来源；最新接口和所有权说明见 [Jobs 协议](./jobs-protocol.md)。额度和 Workflow runner 的后续收拢仍按阶段 B/C 计划执行。
