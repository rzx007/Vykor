# Vykor Agent SDK

> 状态：programmatic agent 的权威使用文档。内部执行结构见 [Agent Runtime Framework Architecture](./agent-runtime-framework-architecture.md)，生命周期终态与失败语义见 [Agent Lifecycle Contract](./agent-lifecycle-contract.md)，daemon 边界见 [Agent Framework Capability Boundary](./agent-framework-capability-boundary.md)。

## 定位

`@vykor/agent-runtime` 是 Vykor 自己的 opinionated Agent SDK。它提供完整默认组装，但不试图成为通用 agent framework。

```text
createDefaultNodeAgent(options)
  -> VykorAgent
     -> submitMessage / runMessage
     -> subscribe
     -> history / model / compact / remember / usage / inspect
     -> children
     -> close
```

`QueryEngine`、`RuntimeBuilder`、provider/tool/hook/MCP/sandbox 的组装是内部实现，不是应用入口。

发布包的 peerDependencies 标为 optional，是安装人体工程学；实现已 bundle，不要假设可以替换 `@vykor/core` / `@vykor/tools` 等 peer 实现。细节见 [Agent Framework Capability Boundary](./agent-framework-capability-boundary.md)。

## 最小运行

```ts
import { createDefaultNodeAgent } from "@vykor/agent-runtime";

const agent = await createDefaultNodeAgent({ cwd: process.cwd() });

const unsubscribe = agent.subscribe((event) => {
  if (event.type === "output.text.delta") process.stdout.write(event.data.delta);
});

const run = agent.submitMessage("What files are in this directory?");
const result = await run.result;

unsubscribe();
await agent.close();
```

`createDefaultNodeAgent()` 自动加载 settings、provider、credentials、默认 tools、prompt、skills、plugins、MCP、memory 与 sandbox。默认工具包含纯本地文件 `Read`，不包含 `ImageToText` 或 `ImageGeneration`。调用方只覆盖需要改变的部分。旧的 `createVykorAgent()` 已删除，不提供别名。

## 创建参数

常用参数全部位于顶层，不存在 runtime factory 或 `overrides` 包装层：

```ts
const agent = await createDefaultNodeAgent({
  cwd,
  model: "gpt-5.4",
  provider: "codex",
  maxTurns: 20,
  hostToolCeiling: ["Read", "Glob", "Grep"],
  capabilityOverrides: {
    terminal: { value: terminal, jobs: terminalJobs },
    backgroundShell: { value: backgroundShell, jobs: shellJobs },
  },
  effects: { requestPermission },
  onEvent: async (event) => {
    await durableEventSink.apply(event);
  },
});
```

| 参数 | 语义 |
|---|---|
| `settings` | 可选显式 settings；缺省时使用标准 settings loader |
| `cwd` / `sessionId` | 工作目录与 live session identity |
| `model` / `provider` / `apiKey` / `baseUrl` | provider 选择覆盖 |
| `client` | programmatic embedding、自定义 provider 或测试用消息客户端 |
| `systemPrompt` / `maxTurns` / `effort` / `fastMode` | 执行行为覆盖 |
| `hostToolCeiling` / `roleAllowedTools` / `disallowedTools` | 工具范围，见下一节 |
| `tools` / `toolOverrides` | 增加 Tool，或按精确名称替换默认 Tool；替换仍经过工具范围、权限、Hook、超时和取消流程 |
| `capabilityOverrides` | 逐项配置默认能力；可接收 Host 对象的能力与只能禁用的 `jobs` / `memory` 见下文 |
| `effects` | 宿主交互副作用；目前 `requestPermission` 是可选 permission effect |
| `onEvent` | 有序、可靠、可等待的 host sink；失败会终止当前 operation |
| `extensions` / `mcpServers` | Vykor extension 与 MCP 增量配置 |
| `childBudget` | 整棵 child 树的深度、活动数和累计创建数限制 |

## 工具限制

工具限制分三层理解：

| 字段 | 大白话含义 |
|---|---|
| `hostToolCeiling` | 宿主给这个 Agent 家族的最大能力。子 Agent 也不能超过它。 |
| `roleAllowedTools` | 当前 Agent 角色自己想看的工具。例如 Coordinator Leader 只需要 `Agent` / `Workflow` / `Job*`，但这不代表 Worker 也只能用这些。 |
| `disallowedTools` | 永远优先禁止。父 Agent 和子 Agent 的禁止列表会合并。 |

后台生命周期旧名已经硬切，不提供兼容别名。`hostToolCeiling`、`roleAllowedTools`、`disallowedTools` 和 auto-approve 配置若仍包含已删除的 `TaskGet/List/Output/Stop/Wait/Update`、`SendMessage` 或 `TerminalRead/List/Send/Signal/Close`，runtime 会在启动时直接报错并给出对应 `Job*`；其他尚未注册的名字仍被保留，供插件动态注册工具使用。工具名精确匹配，不接受 snake_case、Python 风格或大小写修复。

最终能看到的工具是：

```text
可用工具 = 宿主能力上限 ∩ 当前角色工具集 - 禁止工具
```

`["*"]` 表示“这一层不额外收窄”，不是“绕过宿主上限”。例如：

```ts
await createDefaultNodeAgent({
  hostToolCeiling: ["Read", "Agent", "JobWait"],
});
```

这个 Agent 可以派出 Worker，但 Worker 仍然只能在 `Read` / `Agent` / `JobWait` 这个上限内活动，不能因为内置 worker 写了 `tools: ["*"]` 就拿到 `Bash` / `Edit` / `Write`。

## 默认 Node 能力与 Host 覆盖

`createDefaultNodeAgent()` 是开箱即用的 Node 入口：未覆盖时会提供本地 Terminal、Jobs、后台 Shell、Git/worktree child environment、Workflow repository 和 Memory；没有 `effects.requestPermission` 时权限会安全拒绝。Schedules 没有可用的本地默认值，未由 Host 覆盖时状态就是 `unavailable`，相应工具不会注册。

`capabilityOverrides` 按能力独立解析：不传表示使用该能力的默认值，传入 `false` 表示关闭。只有 `terminal`、`backgroundShell`、`childEnvironment`、`workflowRepository` 和 `schedules` 接受 Host 对象作为 override；其中 `terminal` 与 `backgroundShell` 必须使用 `{ value, jobs }` bundle，让 `Job*` 工具能观察与控制它们创建的 Job。`jobs` 与 `memory` 不接受 Host 对象，分别只能设为 `false` 来关闭本地 Jobs 或受管 Memory。

附件不是 Agent Capability。默认 `Read` 只读本地路径，默认 Agent 也不承诺图生文或文生图。`@vykor/tools` 不定义或导出 `ImageToText`、`ImageGeneration`。daemon 作为第一方 Agent 创建者，通过 `toolOverrides` 把 `Read` 扩展为“本地路径 + 当前会话授权附件”，并在 server 内完整定义两个视觉 Tool。`createDaemonAgentLoader` 只调用统一的 `tools({ session, settings })` 获取当前会话的普通工具，不认识任何具体工具名称。daemon 的 `ImageToText` 支持普通路径、图片 URL 和授权后的 `attachment_id`；附件分支会把 Child session 解析到 Root session 后再校验引用。

内部的 `trustedToolOverrides` 只用于第一方 composition root 明确信任自己构造的覆盖，让 daemon 的 `Read` 保留原内置 `Read` 的权限分类。名称必须同时存在于 `toolOverrides`，且目标必须是默认 builtin；普通 `toolOverrides` 默认不继承信任。Extension、Plugin 和 MCP 没有设置或追加可信名称的入口。

`jobs: false` 不是独立开关：Terminal、后台 Shell、child environment 与 Workflow repository 都会产生或依赖 Job，因此必须同时写成 `terminal: false`、`backgroundShell: false`、`childEnvironment: false` 和 `workflowRepository: false`。只替换 Terminal 不会关掉本地后台 Shell 或 Memory。

Host 覆盖是**借用对象**，不是由 Agent 接管的资源：它们必须能覆盖 root session 的整棵 child session tree，且由 Host 自己在合适的生命周期释放。`agent.close()` 只清理 runtime 自己创建的默认资源；不会调用 Host Terminal、后台 Shell 或其 Jobs 的释放逻辑。

Kernel 入口保持可嵌入：它不会创建本地 Terminal、Jobs、child environment 或其他 Node 默认能力，调用方必须明确提供运行时与所需能力。

## Event 与 Effect

SDK 有两种事件消费语义，不能混用：

```text
onEvent(event)       reliable host sink
                     ordered + awaited
                     rejection fails the operation

agent.subscribe(fn) observation
                     ordered invocation + non-blocking
                     listener failure is isolated
```

daemon 使用 `onEvent` 保证 run started、transcript 与 terminal state 已可靠投影后，framework handle 才结算。日志、终端渲染和 SDK 使用者使用 `subscribe()`；observer 按事件顺序被调用，但 framework 不等待其异步工作完成，异常或慢 observer 都不能改变、阻塞 agent 执行。

权限不是 event listener 返回值，而是显式 effect：

```text
permission.requested event
  -> requestPermission(request, context)
  -> permission.resolved event
  -> approved: execute tool
  -> denied/expired: denied tool result
```

## Run Handle

`submitMessage()` 同步预占 agent 并返回 live handle：

```ts
const run = agent.submitMessage("Implement the change");

await run.started;
await run.steer({ content: "Also update the tests" });
await run.interrupt("Caller cancelled");
const result = await run.result;
```

同一 agent 同时只允许一个 root run。需要直接等待结果时使用：

```ts
const result = await agent.runMessage("hi");
```

## 稳定错误类

以下错误类从 `@vykor/agent-runtime` 与 `@vykor/agent-runtime/kernel` 再导出，可用 `instanceof` 判断（与 `@vykor/core` 内定义为同一引用）：

| 错误类 | 何时抛出 |
|---|---|
| `AgentRunNotAcceptingInputError` | run 已关闭 steering / 不再接受输入 |
| `AgentChildBudgetExceededError` | child 深度、活动数或累计创建数超预算 |
| `AgentOperationConflictError` | Agent 在非法状态下执行操作（如 closed 后 `submitMessage`） |

不要依赖解析 `error.message` 字符串。workspace 内的 `@vykor/core` 不是独立发布包；外部消费方应只从上述两个 agent-runtime 入口导入。

## Child Agent

child agent 的 live lifecycle 由 framework 管理。child 继承 root 的 provider/client、权限策略、event sink 与 observation stream，并可覆盖 model、tools、permission mode 和 max turns。

```ts
const child = agent.children.get(childId);
await child?.send({ content: "Continue" });
await child?.interrupt("No longer needed");
```

durable child session/task/run 不进入 SDK；它们由 daemon 根据 `child.*` 与 child run events 建立。

默认工具在纯 SDK 形态下同样闭环，不依赖 daemon 先建立 task projection：

```text
Agent -> context.agent.children.spawnChildAgent() -> jobId
JobWait(jobId) -> AgentJobHost.wait()
JobCancel(jobId) -> AgentJobHost.cancel()
Workflow -> spawn framework child -> await/stop the same child backend
```

`BackgroundShellCreate` 只创建后台 shell Job。工具通过宿主注入的 `AgentBackgroundShellHost` 发起创建，并把稳定的 `toolCallId` 作为请求身份；daemon 将它路由到 `BackgroundShellService`。服务先预留 pending durable execution 和 jobId，再让 `DetachedProcessSupervisor` 按同一个 jobId 幂等启动进程。工具层不直接取得进程 supervisor。child Agent 由 `Agent` 创建，并通过 framework child handle 运行。daemon 可以把 `child.*` 事件投影为 durable execution，供 UI、恢复和审计使用，但该投影不再是 framework child 完成一轮执行的前置条件。

## 两种应用形态

```mermaid
flowchart LR
  Direct["Standalone CLI / embedded app"] --> Agent["VykorAgent"]
  Daemon["Daemon application"] --> Pool["AgentPool"] --> Agent
  UI["TUI / Web / Desktop"] --> Client["VykorClient"] --> Daemon
```

### Direct

应用直接创建、持有并关闭 agent。history 是 live state；应用可用 `getHistory()` / `loadHistory()` 实现自己的文件保存或恢复。

### Daemon

daemon application 每个 durable session 缓存一个 agent：

1. 从 `SessionStore` 读取 durable transcript。
2. `createDaemonAgentLoader()` 合并 settings/session metadata 并调用 `createDefaultNodeAgent()`。
3. loader 通过 `loadHistory()` 恢复 live history并绑定 callbacks。
4. 通过 `onEvent` 写 durable session/run/task/transcript。
5. 通过 `requestPermission` 连接 durable permission broker。
6. `AgentPool` 只负责实例去重、缓存、代际关闭与 active-work 查询。
7. archive、configuration change 或 shutdown 时 `close()`。

daemon 不实例化 QueryEngine，不接收 runtime factory，也不复制 child controls。

## 源码索引

| 要找的逻辑 | 文件 |
|---|---|
| SDK facade 与 run handle | `packages/agent-runtime/src/agent.ts` |
| 默认 composition root | `packages/agent-runtime/src/default-runtime.ts` |
| ordered sink 与 observers | `packages/agent-runtime/src/event-source.ts` |
| child lifecycle | `packages/agent-runtime/src/child-agent.ts` |
| Agent producer | `packages/tools/src/agent/agent-tools.ts` |
| Job lifecycle routing | `packages/tools/src/job`、`packages/server/src/jobs` |
| Workflow child spawn/wait | `packages/tools/src/agent/workflow/runner.ts` |
| child worktree | `packages/agent-runtime/src/child-environment.ts` |
| daemon application composition | `packages/server/src/application/daemon-application.ts` |
| durable session -> live Agent | `packages/server/src/daemon/daemon-agent.ts` |
| daemon agent cache | `packages/server/src/application/agent/agent-pool.ts` |
| durable event projection | `packages/server/src/application/agent/daemon-agent-event-projector.ts` |
| standalone SDK contract test | `packages/agent-runtime/src/sdk.test.ts` |

## 非目标

- 不提供通用 workflow graph runtime。
- 不把 durable store 或 HTTP transport 抽象进 framework。
- 不暴露 QueryEngine/RuntimeBuilder 作为第二套应用入口。
- 不提供 session replacement runtime；切换 durable session 是应用行为。
- 不为旧 runtime factory、host callback 或 projection adapter 保留兼容层。
