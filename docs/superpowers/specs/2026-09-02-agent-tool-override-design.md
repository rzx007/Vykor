# Agent 内置 Tool 显式覆盖设计

## 1. 状态

- 状态：待审核
- 日期：2026-09-02
- 范围：`@vykor/core`、`@vykor/tools`、`@vykor/agent-runtime`
- 前置设计：`2026-09-01-agent-runtime-default-capabilities-design.md`

## 2. 背景

`DefaultNodeAgent` 已经提供完整的默认 Tool，普通调用方不需要 Host 逐项注入才能运行。但业务方仍可能需要替换某个内置 Tool，例如：

- 为 `Read` 增加业务资源协议；
- 使用受控文件服务替换本地文件访问；
- 将 `Bash` 接到远程执行环境；
- 为某个 Tool 增加业务审计或组织级限制。

当前 `ToolRegistry.register()` 遇到同名 Tool 时会打印 warning，然后直接覆盖：

```ts
register(tool: ToolDefinition): void {
  if (this.tools.has(tool.name)) {
    console.warn(`[ToolRegistry] overwriting existing tool: "${tool.name}"`);
  }
  this.tools.set(tool.name, tool);
}
```

这使覆盖行为依赖注册顺序。Extension、Plugin、MCP 或后续 Runtime 集成只要注册同名 Tool，就可能在没有明确声明的情况下改变 Agent 行为。调用方也无法从 `agent.inspect()` 判断最终 Tool 来自哪里。

附件读取暴露了这一扩展缺口，但不是本设计唯一要解决的问题。内置 `Read` 已经支持 `attachment://`，当前首先应该修正其模型可见描述；Tool 覆盖是独立的通用扩展能力，不为附件建立特殊入口。

## 3. 设计结论

采用“默认 Tool + 显式新增 + 显式覆盖”的模型：

```text
创建内置 Tool Registry
  → 注册调用方新增 Tool
  → 应用调用方显式 Tool 覆盖
  → 计算完整工具名集合和可见性限制
  → 安装 Extension / Plugin / MCP（只允许新增）
  → QueryEngine 使用最终 Registry
```

核心规则：

1. `register()` 只负责新增；同名时抛错。
2. `override()` 只负责替换；目标不存在时抛错。
3. 覆盖单位是完整 `ToolDefinition`，不支持局部 patch。
4. 第一阶段只有创建 Agent 的受信任调用方可以声明覆盖。
5. Extension、Plugin 和 MCP 第一阶段不能覆盖任何已注册 Tool。
6. Tool 覆盖不绕过 QueryEngine 的权限、Hook、超时、取消、审计和结果规范化。
7. 自定义实现默认失去内置 Tool 的隐式只读信任，防止同名 Tool 借用 `Read` 等名称自动获批。

## 4. 目标

1. 业务方可以在不 Fork Agent Runtime 的情况下完整替换单个内置 Tool。
2. 新增和覆盖具有不同、可验证的语义。
3. 最终 Tool 不依赖隐含的加载顺序。
4. 重名、拼写错误和不合法覆盖在 Agent 创建阶段失败，而不是运行中才暴露。
5. `agent.inspect()` 可以说明 Tool 的当前来源和被覆盖来源。
6. 自定义 Tool 和覆盖 Tool 继续受现有工具可见性与执行安全管线控制。
7. 父 Agent 与子 Agent 对调用方 Tool 的继承行为明确且可测试。

## 5. 非目标

第一阶段不做：

- Plugin 权限申请和第三方 Plugin 覆盖内置 Tool；
- 根据优先级自动解决多个覆盖者；
- 只修改 `description`、`inputSchema` 或 `execute` 的局部 patch；
- 运行期间热替换 Tool；
- 为 Tool 建立独立依赖注入容器；
- 让 Tool 自己管理 Agent 生命周期资源；
- 兼容当前“后注册者自动覆盖”的行为。

旧结构不需要兼容。同名隐式覆盖属于需要删除的不稳定行为。

## 6. 公共配置 API

在 `VykorAgentOptions` 增加两个字段：

```ts
export interface VykorAgentOptions extends VykorAgentConfiguration {
  // 现有字段省略。

  /** 新增 Tool；名称与任何已有 Tool 冲突时创建失败。 */
  tools?: ToolDefinition[];

  /** 显式替换同名内置 Tool；目标不存在时创建失败。 */
  toolOverrides?: ToolDefinition[];
}
```

示例：

```ts
const agent = await createDefaultNodeAgent({
  cwd,
  tools: [searchBusinessKnowledgeTool],
  toolOverrides: [controlledReadTool],
});
```

语义固定为：

- `tools` 表示“这个名字原来不应该存在”。
- `toolOverrides` 表示“这个名字原来必须存在”。
- 同一个名称不能同时出现在 `tools` 和 `toolOverrides`。
- `tools` 或 `toolOverrides` 内部不允许重复名称。
- Tool 名称继续使用现有精确匹配和大小写规则，不增加别名或自动归一化。

第一阶段 `toolOverrides` 只能覆盖 Agent Runtime 创建的默认 Tool。调用方不能用它声明“将来某个 Plugin 加载后再覆盖”，避免产生时序依赖。

## 7. ToolRegistry API

核心 Registry 改为显式操作：

```ts
export interface ToolRegistrationSource {
  kind: "builtin" | "agent" | "extension" | "plugin" | "mcp" | "runtime";
  id?: string;
}

export interface RegisteredToolInspection {
  name: string;
  source: ToolRegistrationSource;
  overrides?: ToolRegistrationSource;
}

export interface ToolRegistry {
  register(
    tool: ToolDefinition,
    source?: ToolRegistrationSource,
  ): void;

  override(
    tool: ToolDefinition,
    source: ToolRegistrationSource,
  ): void;

  unregister?(name: string): boolean;
  get(name: string): ToolDefinition | undefined;
  getAll(): ToolDefinition[];
  has(name: string): boolean;
  inspect?(name: string): RegisteredToolInspection | undefined;
}
```

`source` 的默认值只用于普通手工 Registry，固定为 `{ kind: "runtime" }`。Agent Runtime 自己注册 Tool 时必须传准确来源。

### 7.1 `register()`

如果名称不存在，加入 Registry。

如果名称已存在，抛出稳定错误：

```text
tool_already_registered: Tool "Read" is already registered by builtin; use an explicit override
```

不再打印 warning 后继续。

### 7.2 `override()`

如果名称存在，完整替换定义，并记录原来源。

如果名称不存在，抛出稳定错误：

```text
tool_override_target_not_found: Cannot override unknown Tool "Raed"
```

这样拼写错误不会悄悄创建新 Tool。

### 7.3 `unregister()`

保持现有语义，用于 MCP 重新连接、Plugin 卸载和 Runtime 清理。注销后重新注册属于新注册，不自动恢复历史覆盖链。

第一阶段只保留一层 `overrides` 来源，不建立完整覆盖历史栈，因为同一 Agent 创建过程中只允许调用方覆盖一次。

## 8. 装配顺序

`createDefaultNodeAgent()` 的具体顺序调整为：

```text
1. createDefaultToolRegistry()
2. register(options.tools, source = agent)
3. override(options.toolOverrides, source = agent)
4. 使用上述最终名称集合计算 allowed / denied
5. 创建 RuntimeToolRegistry 可见性视图
6. 安装 Extension、Native Plugin、MCP 和 Memory Tool
7. 后续来源遇到重名立即失败或将对应集成标记为失败
```

第 4 步必须发生在调用方 Tool 应用之后。否则：

- `hostToolCeiling` 无法识别新增 Tool；
- `roleAllowedTools` 无法允许新增 Tool；
- `disallowedTools` 无法拒绝新增 Tool；
- 子 Agent 工具上限无法稳定继承。

覆盖 Tool 名称不变，因此沿用同名 Tool 的可见性配置；新增 Tool 则进入完整名称集合后再参与过滤。

## 9. Plugin、Extension 与 MCP

第一阶段统一采用“只能新增，不能覆盖”：

- Native Plugin 已有重名检查，继续保留。
- Extension 使用 `register()`；重名时 setup 失败并执行已有回滚。
- MCP Tool 使用 `register()`；重名时该 MCP 连接的 Tool 安装失败，不改变已有 Tool。
- Memory 等 Runtime 后装 Tool 使用 `register()`；内置组装发生名称冲突时 Agent 创建失败。

这些来源不能调用 `override()`。即使接口在 TypeScript 上可见，Agent Runtime 提供给第三方 Extension 的上下文也应暴露一个只含 `register/get/getAll/has` 的受限 Registry 视图，不暴露覆盖入口。

以后如果确实需要 Plugin 覆盖，应单独设计：

- manifest 中的覆盖声明；
- `tools.override` 权限；
- 用户或组织策略批准；
- Plugin 卸载后的恢复行为；
- 来源和审计展示。

在这些问题解决前，不允许通过“最后注册者获胜”绕开权限设计。

## 10. 权限与信任边界

同名不代表同等安全属性。自定义 `Read` 完全可能执行写入或网络请求，因此覆盖实现不能自动继承内置 `Read` 的隐式只读信任。

第一阶段采用安全默认值：

1. `deniedTools` 仍然按名称优先拒绝，覆盖不能绕过。
2. `hostToolCeiling` 和角色 allowlist 仍然按名称限制最大可见范围。
3. 覆盖后的 Tool 不参与 Runtime 内置的只读自动批准集合。
4. `autoApproveTools` 如显式包含该名称，仍表示调用方明确批准。
5. 权限模式本身设置为无需询问时，沿用现有模式语义，不在 Tool 覆盖层重复实现权限系统。

为此，权限判断需要知道最终 Tool 是否仍为 `builtin` 来源。不能只根据 `tool.name === "Read"` 推断它是原始只读实现。

执行流程保持不变：

```text
模型发出 Tool Use
  → 可见性与 deny 检查
  → 权限检查
  → pre_tool_use Hook
  → 统一超时和 AbortSignal
  → ToolDefinition.execute()
  → post_tool_use 与审计事件
  → 结果规范化并返回模型
```

覆盖只替换 `ToolDefinition`，不允许替换上述管线。

## 11. 子 Agent 继承

调用方提供的 `tools` 与 `toolOverrides` 视为 root session tree 的受信任配置，向子 Agent 原样传播，规则与 `capabilityOverrides` 一致：

- 父子 Agent 使用同一组 Tool 定义对象；
- Tool 必须通过 `ToolContext.sessionId`、`cwd` 和信号区分具体执行环境；
- 子 Agent 仍重新应用继承后的 `hostToolCeiling`、自己的 role allowlist 和合并后的 deny；
- 子 Agent 无权新增超出父级 ceiling 的 Tool；
- Tool 定义不由 Agent 调用 `dispose()`，需要生命周期资源的扩展继续使用 Extension cleanup。

如果业务 Tool 不能安全服务整个 session tree，调用方应通过 allowlist 禁止子 Agent 使用它。本阶段不增加 child-aware Tool factory。

## 12. 诊断

`agent.inspect().tools` 从只有名称：

```ts
tools: Array<{ name: string }>;
```

扩展为：

```ts
tools: Array<{
  name: string;
  source: ToolRegistrationSource;
  overrides?: ToolRegistrationSource;
}>;
```

示例：

```json
{
  "name": "Read",
  "source": { "kind": "agent" },
  "overrides": { "kind": "builtin" }
}
```

诊断不展示：

- `execute` 函数源码；
- Tool 输入中的用户数据；
- 凭据和环境变量；
- Host 对象地址；
- 附件或记忆物理路径。

如果 `RuntimeToolRegistry` 因 allow/deny 隐藏一个 Tool，普通 `agent.inspect().tools` 只返回当前 Agent 实际可见的 Tool。内部调试快照可以另行显示隐藏原因，但不属于本阶段。

## 13. 错误处理与原子性

Agent 创建阶段先验证配置，再修改 Registry：

1. 验证 `tools` 内部无重名。
2. 验证 `toolOverrides` 内部无重名。
3. 验证两个数组之间无交集。
4. 验证全部 override 目标存在于默认 Registry。
5. 验证完成后按固定顺序应用。

这样配置错误不会留下半注册状态。

Extension、Plugin 或 MCP 在安装阶段发生重名时：

- 不覆盖现有 Tool；
- 当前集成安装失败；
- 调用已有 cleanup 撤销该集成本轮已经注册的 Tool；
- 是否导致整个 Agent 创建失败，沿用各集成当前的失败策略，不由 Registry 擅自吞错。

## 14. `Read` 附件契约修正

Tool 覆盖能力实现前后，默认 Agent 都应该正确说明已有的附件读取能力。内置 `Read` 的模型可见契约改为：

```ts
description:
  "Read a local file, directory, or Vykor attachment resource. " +
  "Use Read, not ReadMcpResource, for attachment:// resources."

file_path: {
  type: "string",
  description:
    "An absolute local path or the exact attachment:// resource URI provided in the conversation."
}
```

大文本附件提示继续提供精确调用示例：

```json
{
  "file_path": "attachment://att_xxx/document.md",
  "offset": 1,
  "limit": 2000
}
```

这一修正直接解决默认模型容易误选 `ReadMcpResource` 的问题。它不是一个自定义 override，也不依赖业务方配置。

## 15. 测试范围

### 15.1 ToolRegistry 单元测试

- 首次 `register()` 成功。
- 同名 `register()` 抛出 `tool_already_registered`。
- 已存在目标的 `override()` 成功。
- 不存在目标的 `override()` 抛出 `tool_override_target_not_found`。
- `inspect()` 返回最终来源与原来源。
- `unregister()` 清理定义和来源元数据。

### 15.2 Agent Runtime 测试

- `tools` 可以新增 Tool 并被模型看见。
- `tools` 与内置 Tool 重名时 Agent 创建失败。
- `toolOverrides` 可以替换内置 Tool 的描述、Schema 和执行函数。
- `toolOverrides` 拼错名称时 Agent 创建失败。
- 新增与覆盖发生配置交集时 Agent 创建失败。
- 覆盖在 allow/deny 计算前生效。
- denied Tool 即使被覆盖仍不可见、不可执行。
- 覆盖 `Read` 后不继承内置只读自动批准。
- Tool 仍经过 Hook、超时、取消和结果规范化。
- `agent.inspect()` 显示覆盖关系。

### 15.3 子 Agent 测试

- 子 Agent 继承调用方新增和覆盖 Tool。
- 子 Agent role allowlist 可以进一步隐藏这些 Tool。
- 父级 ceiling 不允许子 Agent 扩大工具范围。
- Tool 执行时收到子 Agent 自己的 `cwd` 和 `sessionId`。

### 15.4 集成来源测试

- Extension 与内置 Tool 重名时不会覆盖。
- Native Plugin 与内置 Tool 重名时保持现有冲突错误。
- MCP Tool 与现有 Tool 重名时不会覆盖。
- 集成失败清理本轮已经注册的其他 Tool。

### 15.5 附件回归测试

- `Read` 描述明确包含 `attachment://`。
- `Read` 参数描述允许附件 URI。
- 大文本附件提示明确要求 `Read`，禁止 `ReadMcpResource`。
- `Read({ file_path: "attachment://..." })` 继续调用 `AgentAttachmentResourceHost.readText()`。

## 16. 实施分段

### 阶段一：Registry 语义收紧

- `register()` 改为拒绝重名。
- 增加 `override()` 和来源元数据。
- 修正所有现有注册调用点的来源。
- 为 Extension、Plugin、MCP 保持只能新增的行为。

### 阶段二：Agent 公共配置

- 增加 `tools` 与 `toolOverrides`。
- 在工具可见性计算前应用。
- 向子 Agent 传播。
- 扩展 `agent.inspect()`。
- 覆盖 Tool 降级内置只读信任。

### 阶段三：默认 `Read` 契约修正

- 更新 `Read` 描述和 Schema 文案。
- 更新大文本附件提示。
- 增加防止误用 `ReadMcpResource` 的回归测试。

三个阶段可以放在同一实现计划中，但提交应保持独立，便于审查 Registry 行为变化、公共 API 和附件提示修正。

## 17. 验收标准

1. 普通 `createDefaultNodeAgent({ cwd })` 的默认 Tool 集合和执行行为不变。
2. 任何隐式同名注册都不再覆盖已有 Tool。
3. 调用方可以通过 `toolOverrides` 完整替换一个已存在的内置 Tool。
4. 拼错 override 名称会在 Agent 创建时失败。
5. Extension、Plugin 和 MCP 不能暗中覆盖内置或调用方 Tool。
6. 新增和覆盖 Tool 都受 ceiling、allowlist 和 deny 控制。
7. 覆盖 Tool 不自动继承内置只读批准。
8. Tool 覆盖不绕过 QueryEngine 的统一执行管线。
9. 子 Agent 继承调用方 Tool 配置，但不能扩大父级工具上限。
10. `agent.inspect()` 能解释最终 Tool 来源和覆盖关系。
11. 默认 `Read` 明确支持 `attachment://`，模型不再被引导到 `ReadMcpResource`。
12. 全仓类型检查、Agent Runtime 测试、Tools 测试和相关 Server 附件测试通过。

## 18. 设计取舍

### 18.1 为什么不继续后注册覆盖

它最省代码，但最终行为依赖加载顺序，也允许第三方来源绕过覆盖授权，因此不采用。

### 18.2 为什么不直接传完整 ToolRegistry

调用方传完整 Registry 会失去 `DefaultNodeAgent` 的开箱即用默认值，并让调用方承担内置 Tool 装配、能力开关和来源诊断，不符合默认 Agent 的定位。

### 18.3 为什么第一阶段不支持局部 patch

局部 patch 会产生描述、Schema 与实现来自不同版本的组合，还需要定义深合并规则。完整 `ToolDefinition` 替换更容易理解、验证和测试。

### 18.4 为什么第一阶段不允许 Plugin 覆盖

Plugin 覆盖涉及权限、批准、卸载恢复和供应链信任，不应借用受信任程序化调用方的 API 顺便开放。

### 18.5 为什么覆盖 Tool 要失去内置只读信任

安全属性属于具体实现，不属于名称。自定义 `Read` 可能写文件、访问网络或调用外部服务；继续按名称自动批准会形成权限绕过。

## 19. 最终运行模型

```text
DefaultNodeAgent
  ├─ 提供完整内置 Tool
  ├─ tools：显式新增
  ├─ toolOverrides：显式替换已有内置 Tool
  ├─ Plugin / Extension / MCP：只能新增
  ├─ Tool source：可诊断
  └─ QueryEngine：统一负责权限、Hook、超时、取消、审计和执行
```

这个设计保持 Agent Runtime 开箱即用，同时给受信任业务调用方一个清晰、稳定、可审计的扩展入口。
