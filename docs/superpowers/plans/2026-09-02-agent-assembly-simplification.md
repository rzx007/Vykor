# Agent 组装瘦身实现计划

> **面向 AI 代理的工作者：** 使用测试先行方式执行，每完成一个结构边界就运行聚焦测试。

**目标：** 将 Child 配置派生、Node 默认能力解析和 Runtime 集成安装从现有大函数中拆出，同时保持所有外部行为不变。

**架构：** 新增三个内部职责文件，`agent-composition.ts` 只串联阶段。新模块接收明确依赖并返回现有类型，不建立通用扩展框架。

**技术栈：** TypeScript、Vitest、pnpm workspace。

---

### 任务 1：提取 Child 配置派生

**文件：**

- 创建：`packages/agent-runtime/src/node/runtime/child-agent-options.ts`
- 创建：`packages/agent-runtime/src/node/runtime/child-agent-options.test.ts`
- 修改：`packages/agent-runtime/src/kernel/child-agent.ts`

- [x] 先写测试，断言父配置继承、Child 显式覆盖、allowlist 分层、deny 合并，以及 Host overrides/effects 保持对象身份。
- [x] 运行新测试，确认因为 `deriveChildAgentOptions` 尚不存在而失败。
- [x] 实现纯函数并替换 `AgentChildManager.spawn()` 中的内联对象。
- [x] 运行新测试和 `child-agent.test.ts`。

### 任务 2：提取 Node 默认能力解析

**文件：**

- 创建：`packages/agent-runtime/src/node/capabilities/default-agent-capabilities.ts`
- 修改：`packages/agent-runtime/src/node/runtime/agent-composition.ts`

- [x] 将 ChildManager、Workflow、Local Jobs、Terminal、Background Shell、Jobs、Memory 及可选 Host 能力的解析移动到新模块。
- [x] 保留原有 Job 禁用校验、Terminal cleanup 登记和能力 source 状态。
- [x] 运行 `capability-resolution.test.ts`、`default-node-terminal.test.ts` 和 `agent.test.ts`。

### 任务 3：提取 Runtime 集成安装

**文件：**

- 创建：`packages/agent-runtime/src/node/runtime/runtime-integrations.ts`
- 修改：`packages/agent-runtime/src/node/runtime/agent-composition.ts`

- [x] 将 discovered extensions、调用方 extensions、MCP、Remember 和 Memory Retriever 安装移动到新模块。
- [x] 返回 MCP 连接读取函数，供 Agent inspect 使用。
- [x] 保持 MCP cleanup 由 Runtime 持有。
- [x] 运行 extension、MCP、memory 和 agent 聚焦测试。

### 任务 4：验收

- [x] 使用仓库本地 Vitest 运行 Agent Runtime 全包测试。
- [ ] 运行 Agent Runtime 类型检查。当前被 `packages/services` 缺少 `drizzle-orm/better-sqlite3` 类型依赖阻断；本次文件未出现额外 TypeScript 诊断。
- [x] 运行 `git diff --check` 并人工审查本次文件；工作区其他用户改动保持不变。
