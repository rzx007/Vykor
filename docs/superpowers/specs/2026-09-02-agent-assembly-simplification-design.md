# Agent 组装瘦身设计

## 目标

在不改变公开 API、默认能力、子 Agent 继承、工具集合和资源清理顺序的前提下，降低 `agent-composition.ts` 与 `child-agent.ts` 的阅读成本。

## 边界

本次只做三项结构调整：

1. 将父 Agent 配置派生为 Child Agent 配置的规则提取为独立纯函数。
2. 将 Node 默认能力解析从总组装函数中提取，统一返回最终 capabilities、ChildManager 和 Memory 运行时。
3. 将 Runtime 创建后的 Plugin、Extension、MCP、Remember 与 Memory Retriever 安装提取为独立阶段。

本次不引入依赖注入容器、Capability Provider 注册表、生命周期协议或新的公开导出；不调整 Kernel 组装路径；不改变 `ResolvedAgentCapabilities` 三态语义。

## 目标流程

```text
createDefaultNodeAgent
  -> 解析 cwd/settings/session/discovery
  -> resolveDefaultNodeAgentCapabilities
  -> createVykorRuntime
  -> installVykorRuntimeIntegrations
  -> createAgentSession
  -> createAssembledAgent
```

Child Agent 创建时先调用 `deriveChildAgentOptions`，明确表达以下规则：父级 settings、Host 能力覆盖和 effects 原样借用；cwd/session 使用 Child 环境；模型、Prompt、权限和最大轮数允许 Child 覆盖；工具上限继承 Host ceiling，角色工具使用 Child allowlist，禁用工具合并。

## 文件职责

- `child-agent-options.ts`：只负责 Child 配置派生，不创建 Agent 或资源。
- `default-agent-capabilities.ts`：只负责 Node 默认能力、Job 来源和 ChildManager 的构造，并登记其拥有的资源。
- `runtime-integrations.ts`：只负责向已创建的 Runtime 安装扩展、MCP 和 Memory 集成。
- `agent-composition.ts`：保留顺序编排、初始化失败回滚和 Session 创建。

## 错误与生命周期

保持现有策略：默认 Terminal 由 composition cleanup 持有；Runtime、MCP 和 Sandbox 沿用 Runtime cleanup；初始化失败时先关闭 Runtime，再关闭 composition-owned 能力；Host override 不由 Agent 释放。

## 验证

- Child 配置派生使用独立单元测试锁定继承、覆盖和合并规则。
- 默认能力与 Runtime 集成继续由现有 `agent.test.ts`、`default-node-terminal.test.ts`、`sdk.test.ts` 和扩展相关测试覆盖。
- 运行 agent-runtime 全包测试、类型检查和 `git diff --check`。

