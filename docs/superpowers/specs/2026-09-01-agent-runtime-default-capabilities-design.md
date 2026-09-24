# Agent Runtime 默认能力与 Host 扩展设计

> 状态：已按架构审核意见修订，等待书面规格复审。本文定义目标架构和迁移边界，不包含实现。

## 1. 背景

Vykor 已经具备 Terminal、后台 Shell、Jobs、附件、长期记忆、Workflow、Schedules 等能力，但这些能力目前主要由 Host 注入。结果是：同一个 Agent 在 daemon 中功能完整，换成 CLI、SDK 或测试调用后，只要 Host 没有完成同样的接线，能力就会缺失。

问题不在这些功能本身，而在默认装配的责任放错了位置：

- `AgentKernel` 应保持轻量、可移植，只负责模型循环、工具执行、权限结果和运行状态。
- `DefaultNodeAgent` 应提供 Node 环境下完整且一致的默认装配。
- Host 应只覆盖本地默认无法满足的部分，例如 daemon 的持久任务、会话附件、权限 UI 和长期调度。

现有 `hostCapabilities` 还有一个具体缺陷：代码会根据“是否存在整个 Host 对象”决定是否创建部分本地能力。Host 只接管一项能力，也可能意外关闭其他默认能力。

本设计的目标是：

> `DefaultNodeAgent` 自洽、开箱即用；Host 逐项替换、增强或关闭能力；`AgentKernel` 不绑定 Node 终端、进程和本机持久化。

## 2. 设计目标

1. `createDefaultNodeAgent({ cwd })` 不依赖 daemon 即可获得 Node 环境中能够成立的默认能力。
2. Host 覆盖一项能力时，不影响其他未指定能力。
3. 工具注册、运行实现、提示词、compact 上下文和能力诊断使用同一份解析结果。
4. Terminal、后台 Shell、子 Agent 和 Workflow 产生的长任务都能通过统一 Jobs 工具观察和控制。
5. 长期记忆继续由 agent-runtime 读取、注入和写入，沿用现有 managed `Remember` 与 Markdown 数据。
6. 默认资源由 Agent 释放，Host 传入的资源由 Host 释放。
7. 子 Agent 的默认本地资源相互隔离；Host 覆盖必须明确支持整个会话树。
8. 一次性迁移，不保留旧 `hostCapabilities` 双轨兼容。

## 3. 非目标

本次不做：

- 不恢复 `ContextPersistenceService`，也不把记忆改存 SQLite。
- 不设计新的 `AgentMemoryStore`、通用 Context Service 或通用 Backend。
- 不建立公开或内部的通用 Feature 插件框架。
- 不为 standalone Agent 伪造附件入库、附件目录、OCR 或持久 Schedule 服务。
- 不改变现有长期记忆 Markdown 格式和目录规则。
- 不重写 Terminal、Workflow、Child Agent 或 managed `Remember` 的业务语义。
- 不改变 Plugin、MCP、模型和 Schedule 产品语义。

## 4. 总体边界

```text
daemon / desktop / CLI / SDK
  提供 overrides、会话级附件、权限交互、持久调度和业务 UI
                         │
                         ▼
DefaultNodeAgent
  读取 Settings
  创建 Node 默认实现
  应用逐项 override / false
  组合最终 Job 控制面
  接入工具、提示词、compact 和 cleanup
                         │
                         ▼
AgentKernel
  模型循环、工具调用、权限结果、事件、中断、会话状态
```

这里没有独立的“Agent Feature 层”。Memory、Terminal、Workflow 等名称只是能力领域，不对应 `FeatureRegistry`、生命周期接口或插件协议。

agent-runtime 内可以使用普通、明确的装配函数，例如：

```ts
setupMemory(...);
setupTerminal(...);
setupJobs(...);
setupWorkflow(...);
setupCompactContext(...);
```

这些函数只减少组装文件体积，不形成新的扩展系统。Host 的扩展入口只有本文明确列出的 override、effect 和会话数据 provider。

## 5. Kernel 与 DefaultNodeAgent

### 5.1 AgentKernel

Kernel 负责：

- 模型与工具调用循环。
- Run 状态、事件、中断和取消。
- 执行已经得出的权限决定。
- 接收已经解析完成的工具和能力实现。

Kernel 不负责：

- 探测本机是否有 PTY、Shell 或存储目录。
- 创建 Node 子进程、本机 Repository 或 Markdown 记忆运行时。
- 根据 Host 是否存在推断默认能力。
- 管理 daemon 的附件、任务和调度状态。

直接使用 Kernel 的调用方自行提供完整依赖，适合测试、浏览器和受限嵌入场景。

### 5.2 DefaultNodeAgent

`DefaultNodeAgent` 是普通 Node 调用方的主要入口，负责：

1. 读取 cwd、Settings、Session 和本机配置。
2. 创建现有 `AgentMemoryRuntime`、Child Manager、Workflow Repository 等默认对象。
3. 应用逐项 override 或显式关闭。
4. 把所有长任务来源组合成一个最终 `AgentJobHost`。
5. 将最终实现同时接到工具、QueryEngine、提示词和 compact。
6. 登记并释放由 runtime 创建的资源。

## 6. 公开配置模型

旧 `hostCapabilities` 改为 `capabilityOverrides`。三态规则为：

| 值 | 含义 |
|---|---|
| 未传或 `undefined` | 使用该运行环境的默认行为 |
| 实现对象 | 使用 Host 提供的实现 |
| `false` | 明确关闭该能力 |

`false` 是编程接口唯一的显式关闭值。Settings 中已有的 enable/disable 开关在装配入口归一化为同一结果；`disallowedTools` 只隐藏工具，不改变底层能力状态。

目标接口如下：

```ts
type CapabilityOverride<T> = T | false;

interface ObservableJobProducer<T> {
  value: T;
  jobs: AgentJobHost;
}

interface AgentCapabilityOverrides {
  terminal?: CapabilityOverride<ObservableJobProducer<AgentTerminalHost>>;
  backgroundShell?: CapabilityOverride<
    ObservableJobProducer<AgentBackgroundShellHost>
  >;
  jobs?: false;
  attachments?: CapabilityOverride<AgentAttachmentResourceHost>;
  memory?: false;
  childEnvironment?: CapabilityOverride<AgentChildEnvironmentProvider>;
  workflowRepository?: CapabilityOverride<WorkflowRunRepository>;
  imageToText?: CapabilityOverride<AgentImageToTextHost>;
  schedules?: CapabilityOverride<AgentScheduleEffects>;
}

interface AgentEffects {
  requestPermission?: RequestPermission;
}
```

这里有两个有意为之的限制：

- Memory 第一阶段只允许使用现有 agent-runtime 默认实现或 `false`，不接受新的存储接口。
- Jobs 是其他能力共同产生的控制面，不接受一个对象直接替换整个最终 Jobs；Host 的 Job 来源随 Terminal 或后台 Shell override 一起提供。

同一个 Host `AgentJobHost` 可以被多个 producer bundle 引用。装配时按对象身份去重，只加入最终 Jobs 一次。

### 6.1 为什么 Job producer 必须携带 Jobs

`AgentTerminalHost.open()` 和后台 Shell 会返回 Job ID，但观察、输入、等待和取消通过 `AgentJobHost` 完成。只替换 producer、不替换观察来源，会产生“任务启动成功，但 Agent 再也看不到它”的半能力。

因此 Host Terminal 和 Host Background Shell 必须以 `{ value, jobs }` 成对传入。类型结构直接表达这个契约，不依靠文档约定或运行时猜测。

### 6.2 `jobs: false`

Jobs 被明确关闭时，所有会产生可持续 Job ID 的能力也必须显式关闭，包括 Terminal、后台 Shell、Child Agent 和 Workflow。否则组装直接报配置错误，不静默产生不可观察的任务。

正常情况下没有必要单独关闭 Jobs；调用方通常通过工具白名单限制角色能否使用 Job 工具。`jobs: false` 只服务于需要彻底禁止后台任务的受限运行时。

## 7. 能力解析结果

内部保留一份轻量、只读的最终结果：

```ts
type ResolvedCapability<T> =
  | { status: "available"; value: T; source: "default" | "override" }
  | { status: "disabled" }
  | { status: "unavailable"; reason: string };

interface ResolvedAgentCapabilities {
  terminal: ResolvedCapability<AgentTerminalHost>;
  backgroundShell: ResolvedCapability<AgentBackgroundShellHost>;
  jobs: ResolvedCapability<AgentJobHost>;
  attachments: ResolvedCapability<AgentAttachmentResourceHost>;
  memory: ResolvedCapability<AgentMemoryRuntime>;
  childEnvironment: ResolvedCapability<AgentChildEnvironmentProvider>;
  workflowRepository: ResolvedCapability<WorkflowRunRepository>;
  imageToText: ResolvedCapability<AgentImageToTextHost>;
  schedules: ResolvedCapability<AgentScheduleEffects>;
}
```

这不是服务定位器，也不暴露实现对象给 UI。它只在装配期和 Agent 内部使用；公开的 `agent.getCapabilities()` 返回去除 `value` 的诊断快照。

不新增 `agent.capabilities.resolved` 事件。当前没有动态消费者需要这个事件，调用方在创建完成后查询一次即可。

## 8. 默认能力清单

| 能力 | `DefaultNodeAgent` 默认行为 | 结果 |
|---|---|---|
| Files | 现有工作区文件工具 | available |
| Terminal | `LocalTerminalProvider` + Job 适配 | available |
| Background Shell | 现有 `LocalAgentJobHost` | available |
| Jobs | 聚合本地 Terminal、Shell、Child 和 Workflow 来源 | available |
| Memory | 现有 `createAgentMemoryRuntime()` + managed `Remember` | available，受 Settings 控制 |
| Child Environment | 现有默认 Node 子 Agent 环境 | available |
| Workflow | `FileWorkflowRunRepository({ cwd })` | available |
| Skills | 现有本地发现和原生 Skill 加载 | available |
| Attachments | 无 standalone 入库和会话目录 | unavailable |
| Image to Text | 没有 Provider | unavailable |
| Schedules | 没有持久调度器 | unavailable |

“开箱即用”指 standalone 环境能够诚实提供的能力，而不是为所有 daemon 业务能力制造空实现。附件必须先有会话授权、asset ID、MIME 和内容入库；Schedules 必须在进程退出后仍可唤醒任务。两者没有对应基础设施时应明确 unavailable。

## 9. Jobs 是统一控制面

### 9.1 Job 来源

最终 `AgentJobHost` 由一个具体的组合器产生，来源包括：

```text
LocalTerminalProvider 的 Terminal Job 适配 ──┐
LocalAgentJobHost 的后台进程 ────────────────┤
AgentChildManager 的子 Agent ────────────────┼─→ CompositeAgentJobHost
WorkflowRunRepository 的 Workflow Run ──────┤
Host producer bundle 携带的 Job Host ───────┘
```

`CompositeAgentJobHost` 是解决现有长任务控制问题的具体组件，不是通用依赖注入容器。它只实现 `AgentJobHost`：

- `list` 合并各来源，并按来源身份与 Job ID 去重。
- `read`、`wait`、`send`、`cancel` 根据 Job ID 所属来源路由。
- 新创建的本地 Job 在创建时登记来源。
- 对重启后恢复或 Host 已存在的 Job，组合器通过各来源的 `list/read` 建立归属。
- 多个来源声称拥有同一个 Job ID 时，返回明确冲突错误，不随机选择。

每个来源必须只投影自己对应 producer 创建的 Job。daemon 当前的 `DaemonJobService` 同时汇总 Terminal、session task 和 Workflow；迁移后要在对 Agent 的适配层拆成不重叠的来源：Terminal bundle 只提供 Terminal Jobs，后台 Shell bundle 只提供它创建的 detached process Jobs，Child 和 Workflow 继续由各自 resolved 本地来源提供。daemon 内部仍可复用同一个 service 和 store，不要求拆掉业务服务，只需收窄交给组合器的投影视图。

### 9.2 LocalAgentJobHost 调整

当前 `LocalAgentJobHost` 在构造函数中自行创建 `FileWorkflowRunRepository`。这会导致 Workflow 工具关闭或替换 Repository 后，Jobs 仍然通过另一份隐式 Repository 暴露 Workflow。

目标构造方式改为显式注入：

```ts
new LocalAgentJobHost({
  cwd,
  sessionId,
  childManager,
  workflowRepository, // undefined 表示没有 Workflow Job 来源
});
```

同一份 resolved `workflowRepository` 同时交给 Workflow 工具和 `LocalAgentJobHost`。`workflowRepository: false` 时，两边同时消失。

### 9.3 Terminal 闭环

`LocalTerminalProvider` 已有 create/write/resize/read/wait/signal/kill/list/subscribe/dispose 能力，但 `AgentTerminalHost` 只暴露打开入口。默认 Terminal 适配必须同时提供：

- `AgentTerminalHost`：供 Terminal 工具创建会话。
- `AgentJobHost` 来源：把 Terminal 会话映射到 list/read/wait/send/cancel。
- cleanup：关闭 provider 创建的本地资源。

这三部分来自同一个 provider，不重复实现 PTY。

## 10. Memory

Memory 保持现有 `AgentMemoryRuntime`：

```ts
interface AgentMemoryRuntime {
  manager: MemoryManager;
  directory: string;
  retrieve(...): Promise<...>;
  remember(...): Promise<...>;
}
```

agent-runtime 继续负责：

- 创建 `AgentMemoryRuntime`。
- 检索相关记忆并临时注入模型上下文。
- 注册 managed `Remember`。
- user scope 通过现有受管入口更新 `USER.md`。
- project scope 通过现有 `MemoryManager` 写项目 Markdown。
- Run 后执行现有自动提取，并避免与主动 Remember 重复。
- 阻止通用 Write/Edit 修改受管记忆路径。

第一阶段不允许 Host 替换 Memory。原因是现有 user scope、project scope、检索、Remember 和自动提取并不是一个简单 Store；贸然抽一个 `AgentMemoryStore` 会把已经存在的语义拆坏，或重新创造重型 Context Service。

若未来确实需要远程 Memory，单独设计最小持久化协议，并先明确 user/project scope、并发更新和路径不可见性。它不属于本次装配重构。

长期 Memory 与 Session Memory 继续分离：

- 长期 Memory 跨会话保存稳定偏好、事实和项目知识。
- Session Memory 是 compact checkpoint，保存当前目标、进度和下一步。

## 11. Compact 上下文

不建立通用 contributor registry。agent-runtime 直接组合当前已有的两个来源：

```ts
runtime.queryEngine.setCompactContextProvider(async () => ({
  attachmentCatalog: await attachmentCatalogProvider?.(),
  sessionMemory: await sessionMemoryProvider?.(),
}));
```

目标 API 将当前含义过窄的 `setAttachmentsProvider` / `CompactAttachmentsProvider` 一次性改名为 `setCompactContextProvider` / `CompactContextProvider`。

daemon 在创建 Agent 时分别传入：

- 会话附件目录 provider。
- Session Memory checkpoint provider。

两者由 agent-runtime 汇总后只接一次 QueryEngine。这样附件接线被替换时不会漏掉 Session Memory，也不需要引入任意扩展点。

## 12. Attachments

现有 `AgentAttachmentResourceHost` 只负责按 `assetId` 读取文本；它不负责：

- 接收和保存上传文件。
- 生成 asset ID。
- 建立 session 与附件的授权关系。
- 构造附件目录。
- MIME 检测、转换和就绪状态。

这些能力目前属于 daemon 的会话与附件应用服务。因此：

- standalone 默认 Attachments 为 unavailable，不注册附件读取工具，也不宣称具有附件能力。
- daemon 继续通过 override 提供 `AgentAttachmentResourceHost`，并通过独立 provider 提供 compact 目录。
- `attachmentResourceRoot` 暂时保留为 sandbox 的只读挂载配置；它不是 `AgentAttachmentResourceHost` 的替代品。
- 将来若要 standalone 附件能力，应另行设计完整的 intake bundle，而不是只创建一个目录读取器。

## 13. Workflow 与 Schedules

### 13.1 Workflow

Workflow 是 standalone 默认能力。`DefaultNodeAgent` 默认创建一份 `FileWorkflowRunRepository({ cwd })`，并将同一个实例交给：

- Workflow 工具和执行逻辑。
- `LocalAgentJobHost` 的 Workflow Job 来源。

Host 可以覆盖 Repository。`workflowRepository: false` 同时关闭 Workflow 工具和 Workflow Job 来源，不存在第二份隐式 Repository。

### 13.2 Schedules

Schedules 从 `AgentEffects.schedules` 移到 `capabilityOverrides.schedules`。现有 Schedule 工具和业务语义不变。

standalone 默认 unavailable，因为 `setTimeout()` 不能满足进程退出后继续调度的契约。daemon 或未来的常驻本地 scheduler 显式提供实现。

## 14. 权限

`requestPermission` 是可选交互 effect，不是 Agent 能否创建的前提：

```text
PermissionChecker → allow
  直接执行

PermissionChecker → deny
  直接拒绝

PermissionChecker → ask，存在 requestPermission
  请求 Host / CLI 用户确认

PermissionChecker → ask，不存在 requestPermission
  安全拒绝，并说明没有可用审批器
```

权限拒绝是单次操作结果，不改变 capability 状态。`full_auto` 沿用现有显式授权语义，本次不重新定义。

## 15. 子 Agent

子 Agent 遵循两条规则：

1. runtime 默认能力按子 Agent 的 cwd/session 重新创建，不共享父 Agent 的本地 Terminal、Job Host 或 cleanup。
2. Host override 对象原样传给子 Agent，并被视为“整个 root session tree 可用”的借用对象。

因此 Host 提供的 Terminal、Job、附件、Schedule 等实现必须能根据调用上下文处理父会话及其后代。daemon 现有 Job Host 已按 session tree 路由，属于符合契约的实现。

第一阶段不增加 override factory。当前没有必须为每个子 Agent创建独立 Host 对象的真实调用方；如果以后出现，再增加明确的 child-aware factory，而不是现在提前建立通用工厂系统。

最终工具集合仍为：

```text
能力可用
  ∩ Host tool ceiling
  ∩ Agent role allowed tools
  - disallowed tools
```

工具不可见不等于能力被关闭。

## 16. 生命周期

不依赖各协议拥有统一 `dispose()`。默认工厂返回值与清理动作：

```ts
interface CreatedCapability<T> {
  value: T;
  cleanup?: () => Promise<void> | void;
  cleanupIdentity?: object;
}
```

规则：

- runtime 创建对象后立即把 cleanup 压入清理栈。
- Host override 是借用对象，不登记 cleanup。
- 共享底层资源使用相同 `cleanupIdentity`，只登记一次。
- 初始化失败时按创建逆序执行 cleanup，然后抛出原始错误。
- `agent.close()` 按逆序执行剩余 cleanup，并保持幂等。
- 一项 cleanup 失败不阻止后续 cleanup；错误汇总到最终 close/assembly 错误中。

不新增通用生命周期接口，也不要求修改所有 capability 协议。

## 17. 错误和诊断

基础默认能力或明确 override 初始化失败时，Agent 创建失败；Image to Text、Attachments、Schedules 没有实现时记录为 unavailable。

组装错误使用现有 Error 体系和 `cause`，消息必须包含：

- 失败阶段，例如 settings、capability、tools、compact 或 session。
- 能力名称。
- 可执行的处理建议：修复默认环境、提供 override，或明确传 `false`。
- cleanup 失败摘要（如果存在）。

不新增 `AgentAssemblyError` 类，除非实现时发现多个调用方确实需要稳定地按错误类型分支。

`agent.getCapabilities()` 返回不含实现对象和路径的快照：

```ts
{
  terminal: { status: "available", source: "default" },
  jobs: { status: "available", source: "default" },
  attachments: { status: "unavailable", reason: "No attachment intake configured" },
  schedules: { status: "unavailable", reason: "No persistent scheduler configured" },
}
```

诊断不得暴露记忆目录、附件根目录、环境变量、凭据或实现对象。

## 18. Plugin 与 MCP

Plugin 和 MCP 继续是额外工具来源，不进入 `ResolvedAgentCapabilities`。

装配顺序保持具体：

```text
解析默认能力和 overrides
  → 接入内置工具与上下文
  → 安装 Plugins
  → 连接 MCP tools
  → 应用 tool ceiling、角色限制和 disallowedTools
```

Plugin 或 MCP 不能通过同名工具暗中替换内置能力。真正的替换必须走明确 override；本次不增加 Feature replacement API。

## 19. API 迁移

旧形式：

```ts
createDefaultNodeAgent({
  hostCapabilities: {
    permissions: { requestPermission },
    terminal,
    jobs,
    backgroundShell,
    schedules,
  },
});
```

目标形式：

```ts
createDefaultNodeAgent({
  capabilityOverrides: {
    terminal: { value: terminal, jobs },
    backgroundShell: { value: backgroundShell, jobs },
    schedules,
  },
  effects: {
    requestPermission,
  },
  compactContext: {
    attachmentCatalog: buildAttachmentCatalog,
    sessionMemory: readSessionMemoryCheckpoint,
  },
  attachmentResourceRoot,
});
```

monorepo 内一次性迁移 agent-runtime、server/daemon、desktop、CLI、SDK、测试和文档，并删除：

- `AgentHostCapabilities` 与 `hostCapabilities`。
- “只要 Host 对象存在就不创建本地默认能力”的条件。
- 工具注册专用的 capability boolean 投影。
- `AgentEffects.schedules`。
- `setAttachmentsProvider` 旧命名。

不保留兼容适配层。

## 20. 实施阶段

整体方向是一份长期设计，但实现拆成三个可以独立验证的阶段。每阶段完成后必须通过现有 daemon 回归测试再进入下一阶段。

### 阶段一：装配入口、权限和基础默认值

- 引入 `capabilityOverrides` 三态解析，移除 `hostCapabilities`。
- 把 `requestPermission` 改为可选 effect，把 Schedules 移到 capability override。
- 归一化 Settings 开关、`false` 和工具可见性。
- 保持现有本地 Background Shell/Jobs 行为，修复“部分 Host 注入关闭所有默认值”。
- 引入 `CompositeAgentJobHost`，让现有本地来源与 Host producer bundle 可以同时工作。
- 将 daemon 的聚合 Job Host 适配为不重叠的 Terminal、后台 Shell 等来源。
- 提供 `getCapabilities()` 诊断。

验收重点：无 Host 的 Files、Background Shell、Jobs 可用；单项 override 不影响其他默认能力；ask 无回调时安全拒绝。

### 阶段二：Memory、Workflow、compact 和子 Agent 契约

- Memory 收回 agent-runtime 默认装配，只支持默认或 `false`。
- Workflow Repository 只创建一次并显式注入 `LocalAgentJobHost`。
- 直接组合 attachment catalog 与 Session Memory，改名 compact provider。
- Attachments standalone 明确 unavailable，保留 `attachmentResourceRoot`。
- 固化 Host override 对整个 session tree 可用的契约。

验收重点：Remember 和自动提取不回归；compact 同时包含附件目录与 Session Memory；关闭 Workflow 后 Jobs 不再看到 Workflow Run。

### 阶段三：Terminal 与统一 Jobs 控制面

- 用现有 `LocalTerminalProvider` 创建默认 Terminal bundle。
- 实现 Terminal 到 `AgentJobHost` 的适配。
- 将本地 Terminal 来源接入阶段一已经建立的 Jobs 组合器。
- 补齐资源 cleanup 与 Terminal/Job 联合测试。

验收重点：standalone 能打开 Terminal，并通过 Job list/read/send/wait/cancel 完整控制；混合使用 Host producer 与本地 producer 时路由正确。

## 21. 测试契约

### 21.1 覆盖与默认值

- `undefined` 使用默认实现。
- 对象使用 override，不创建对应默认对象。
- `false` 不创建默认对象并标记 disabled。
- 覆盖 Terminal 不改变 Memory、Workflow、Child Environment 等无关能力。
- Attachments、Schedules、Image to Text 在没有实现时为 unavailable，不注册对应工具。

### 21.2 Jobs 联合契约

- 默认 Terminal 创建的会话可被 Job list/read/send/wait/cancel 操作。
- 默认后台 Shell、子 Agent 和 Workflow 出现在同一 Job 列表。
- Host Terminal/Background Shell 的 Job Host 被加入组合器且按身份去重。
- 本地与 Host 使用相同 Job ID 时返回冲突错误。
- `jobs: false` 与仍启用的 Job producer 同时出现时，组装失败。

### 21.3 Memory

- 检索结果注入当前上下文但不写入消息历史。
- managed Remember 按 user/project scope 写现有 Markdown。
- 通用 Write/Edit 继续拒绝受管记忆路径。
- Run 已主动 Remember 时不重复自动提取。
- Settings 禁用或 `memory: false` 时不检索、不写入、不注册 Remember。

### 21.4 Workflow 与 compact

- Workflow 工具和 Jobs 使用同一 Repository。
- `workflowRepository: false` 同时移除工具和 Job 来源。
- compact 同时获得 attachment catalog 和 Session Memory。
- daemon 只替换附件实现时，Session Memory 仍被注入。

### 21.5 子 Agent 与生命周期

- 默认本地能力按子 cwd/session 新建。
- Host override 可用于 root session 和后代，且不由任何 Agent 释放。
- runtime cleanup 逆序、去重且幂等。
- 中途初始化失败会清理已经创建的资源。
- cleanup 失败不掩盖原始组装错误。

### 21.6 回归

- daemon 现有 Terminal、Jobs、附件、Session、Schedules 和事件流通过。
- CLI、SDK 不传 Host 时使用默认能力。
- Plugin/MCP 工具发现和最终工具限制保持现有语义。

## 22. 完成标准

1. `DefaultNodeAgent` 在 Node 环境中不依赖 daemon 即可使用 Files、Terminal、Background Shell、Jobs、Memory、Child Agent 和 Workflow。
2. standalone 不虚报 Attachments、Schedules 和 Image to Text。
3. Host 单项 override 不关闭无关默认能力。
4. 每个产生 Job ID 的能力都有可用的 Job 观察与控制来源。
5. Workflow 工具与 Jobs 不会使用两份 Repository。
6. Memory 沿用现有运行时和 Markdown，不引入新的存储抽象。
7. compact 同时读取附件目录和 Session Memory checkpoint。
8. 子 Agent 默认资源隔离，Host override 明确支持会话树。
9. runtime-owned 资源可靠清理，Host-owned 资源不被 Agent 释放。
10. 工具、实现、提示词、compact 和诊断均来自同一份解析结果。
11. 旧 `hostCapabilities`、`AgentEffects.schedules` 和 `setAttachmentsProvider` 不再保留双轨。
12. 三个实施阶段分别通过测试和 daemon 回归后再继续。
