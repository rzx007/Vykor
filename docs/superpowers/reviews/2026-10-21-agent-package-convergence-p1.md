# P1：公共基础类型与本机配置拆分记录

日期：2026-10-21。对应计划 T01、T02，迁移编号 M01–M04。

P1 已完成并验证，公共类型、配置隔离和主要消费者验证通过；Sandbox 最终 44 项通过、2 项因环境条件跳过。P2–P6 未启动。

## 1. 已迁移的职责

| 原位置 | 唯一规范位置 | 范围 |
| --- | --- | --- |
| core `types/messages.ts`、`usage.ts` | `agent-contracts/src/messages.ts`、`usage.ts` | 消息、内容块、用量和用量统计接口 |
| core `engine/model-retry.ts` 的共享数据 | `agent-contracts/src/model.ts`、`errors.ts` | 失败分类、统一错误、生成/尝试身份、重试状态、尝试结算数据；算法和重试策略仍归 core |
| core `types/runtime-child.ts` 的预算部分 | `agent-contracts/src/children.ts` | 子 Agent 预算、快照、拒绝错误 |
| core `types/tools.ts` 的结果标记 | `agent-contracts/src/tool-data.ts` | 失败种类与执行完成状态；ToolDefinition 和执行上下文未提前迁移 |
| core `types/hooks.ts`、`permissions.ts` 的执行数据 | `agent-contracts/src/hooks.ts`、`permissions.ts` | Hook 事件、事件列表、执行结果和权限判定结果 |
| core `context-budget/types.ts` 的公共输入 | `agent-contracts/src/context-usage.ts` | ContextBucketId、ContextLedgerSegment；统计、快照装配和提示仍归 core |
| core `utils/tool-names.ts` | `agent-contracts/src/tool-names.ts` + `host-config/src/tool-configuration.ts` | 通用名称规范与产品配置中的退役名称校验分开 |
| core `config/` | `host-config/src/` | 配置解析、路径、Git 目录识别、读取、文件锁、冲突检测和原子保存；原有测试随实现迁移 |
| core `types/settings.ts` | `host-config/src/settings-types.ts` | Settings、PermissionSettings、环境和 Provider 配置等 |
| core 的 PermissionMode、PermissionRule、HookDefinition | `host-config/src/permissions.ts`、`hooks.ts` | 配置数据；执行接口暂留 core 至 T07 |
| core `types/mcp-oauth.ts` 的配置/凭据部分 | `host-config/src/mcp-credentials.ts` | OAuth 配置、凭据文件格式、服务器身份和公开状态数据 |
| core 的 MCP 活体协调接口和默认实现 | `mcp/src/runtime-coordination.ts` | Registry、Coordinator、运行句柄和 unavailable 协调器 |
| API 对 core 默认策略的引用 | `api/src/providers/retry.ts` | 单请求默认连接超时 60 秒、流空闲超时 300 秒；新增回归测试 |

删除了已迁移的 core 配置目录、消息/用量文件、工具名文件和默认 MCP 协调器文件；core 入口不转发已迁符号。按符号更新 packages、CLI 和跨包测试，包括动态导入、测试替身、package.json 与锁文件。权限与引擎的集成测试归入 `agent-runtime/src/permission-schema.integration.test.ts`，继续由默认包测试覆盖。

## 2. 依赖与行为核对

- `agent-contracts` 不引用 Node、host-config、core、protocol 或 MCP 实现；当前没有 workspace 运行时依赖。后续只允许类型引用 environment。
- `host-config` 仅依赖 agent-contracts 和 protocol；不引用 core、Agent 生命周期或 MCP 活体连接。
- ApprovalMode、WorkMode 的规范仍在 protocol；没有复制枚举。sandbox 只为规范审批模式类型引用 protocol；terminal-node 原先经 terminal/jobs 引用的协议数据也纳入明确允许范围。
- 对 8 个配置实现按 TypeScript 语法树去掉导入和注释后比较，迁移前后实现体一致。文件名和默认路径、设置与凭据格式、锁及原子保存行为保持原样；配置测试全部使用临时目录。
- `ModelRequestFailure` 保留 `Symbol.for("@vykor/core/ModelRequestFailure")`，测试覆盖独立 bundle 的同一错误身份。complete / partial / unknown、消息压缩标记与工具失败字段保持原样。
- 未改变 SQLite / HTTP / SSE 格式，也未提取进程、LSP 或改变资源所有权。

## 3. 架构检查与例外

`currentPhase` 已推进至 P1。架构检查和 36 项边界测试通过，其中新增基础包禁止反向引用、配置禁止依赖 MCP 活体连接的反例。

| 截止阶段 | P0 记录 | P1 实施后 |
| --- | ---: | ---: |
| P1 | 490 | 0 |
| P2 | 3 | 1 |
| P3 | 11 | 9 |
| P4 | 580 | 596 |
| P5 | 13 | 13 |
| P6 | 31 | 29 |
| 总计 | 1,128 | 648 |

删除失效例外，只为迁移后的同一依赖映射新路径或拆分后的符号组。core 原先在同包引用的配置现在成为显式 host-config 依赖，执行接口和宿主组装的清理仍由 T07 负责，保留精确到文件与符号的 P4 例外。

同时修正 P0 矩阵中两处过早截止：MCP 使用的 ToolDefinition、插件使用的 ToolResult / HookExecutor 按 T01 明确保留至 P4，不能为清空 P1 计数而提前把执行上下文搬进 contracts。相关配置依赖已经迁出；未放宽新依赖检查，也未整体重新生成白名单。

## 4. 验证结果

| 验证范围 | 结果 |
| --- | --- |
| `pnpm check-types` | 65 个任务成功，包含依赖构建和 Runtime 的声明、Kernel/Node bundle 构建 |
| 桌面 `pnpm --filter @vykor/desktop typecheck` | node、web、MCP Apps SDK 三项通过 |
| agent-contracts | 11 项通过 |
| host-config | 105 项通过，覆盖用户/项目配置、并发保存、失败原子性、锁与 MCP 校验 |
| auth / permissions / mcp | 50 / 64 / 169 项通过 |
| API | 276 项通过，含请求超时默认值回归测试 |
| core 消息、重试、引擎和上下文统计 | 64 项通过 |
| Runtime 生命周期、事件、子 Agent、工作树和应用策略 | 83 项通过 |
| 权限与引擎集成测试（迁入 Runtime） | 4 项通过 |
| Server 投影、运行执行器、Shell 组装和 daemon | 77 项通过 |
| CLI daemon / MCP 协调器 | 16 项通过 |
| Sandbox（最终单 worker 补跑） | 44 项通过、2 项跳过；没有失败 |
| 边界测试 / 聚合架构检查 | 36 项通过；旧调用基线 109，阶段例外 648 |
| `pnpm install --offline --frozen-lockfile --ignore-scripts` | 锁文件与全部 36 个 workspace 项目一致，无需重新解析依赖 |
| `pnpm check-docs` / `git diff --check` | 462 个 Markdown 文件检查通过；差异格式检查通过 |

以上测试与边界检查合计 999 项通过、2 项跳过，不重复累计补跑的同一用例。

第一次配置测试因目录迁移少了一层、测试仍按旧深度读取仓库规则文件而失败；已修正相对路径并补跑整个配置测试，105 项通过。

Sandbox 初次并行验证遇到 Windows Shell 探测和 Git sh 启动超时、WSL 探测/取消超时。第一次降低并发后的 `src` 测试仍有一项在 3 秒 Shell 探测窗口内失败。探测实现未修改；P1 仅修改 Settings / loadSettings 的导入。随后直接执行 PowerShell 探测成功。其他重任务结束后，完整补跑通过：

```powershell
pnpm --filter @vykor/sandbox test -- --maxWorkers=1 --minWorkers=1 --testTimeout=30000
```

最终 44 项通过、2 项跳过。WSL 的工作目录/环境/文件用例因本次 preflight 探测失败跳过；其余 WSL 取消、文件搜索、后台 Shell、MCP 和真实 PTY 用例均通过。SRT e2e 按现有平台条件跳过。没有扩大范围修改 Shell、WSL 策略或测试中的探测超时，也未把跳过项表述为已验证。

## 5. 后续阶段

下一阶段是 P2 / T03：提取 execution-node，明确本地执行资源的创建者、复用范围与关闭责任。P1 暂留 core 的 ToolDefinition、StreamingMessageClient、执行上下文和 Hook 执行接口继续在 T07 统一收敛。
