# Vykor 文档体系设计与缺口

> 状态：P0/P1/P2 和旧文档整理已全部完成，2026-08-23。本文保留当时的文档缺口和设计理由；当前入口见 [文档总目录](../README.md)。

## 目标

文档要让三类读者都能顺着同一个入口找到答案：

1. 新读者先看清整个系统为什么分成 Runtime Kernel、Durable Application 和产品入口。
2. 开发者能从一条硬规则找到状态、代码入口、失败行为和回归测试。
3. 运维和产品开发者能知道数据放在哪里、进程挂掉后发生什么、怎样排障和恢复。

README 负责导航；每份细节文档只负责一个清楚的问题。不要再写一份同时混合架构、实施步骤、历史复盘和用户手册的“大而全”文档。

本文沿用 [文档总入口](../README.md) 中对 durable、terminal、projection、repository、contract、snapshot 和 SSE 的白话解释。

## 建议的六层结构

### 第 0 层：系统鸟瞰

回答：整个项目是什么，各层怎样连接，数据和控制从哪里经过。

需要一份新的 `architecture-overview.md`，内容包括：

- CLI、TUI、Web、Desktop、IDE、Bot、Workflow 都是产品入口；
- 入口通过 client/HTTP 或内嵌调用进入 Durable Agent Application；
- Application 保存 Session/Input/Run/Message/Permission/Workflow，并负责恢复和多客户端；
- Agent Runtime Kernel 只负责 live Agent/Run/Child、模型回合、Tool 和资源释放；
- provider、文件、Git、MCP、Sandbox、Terminal 是 Node 宿主能力；
- 一条 prompt 从入口到 terminal result 的主路径；
- 哪些包是公开包，哪些是内部实现；
- 关键硬规则的链接，不在本页重复细节。

现有 `agent-framework-capability-boundary.md` 可以提供分层和所有权，`daemon-application-architecture.md` 可以提供主请求链，但两者都不是面向整个产品的鸟瞰页，因此不建议简单改名代替。

### 第 1 层：跨模块契约

回答：哪些规则不能因为重构而变化。

已有：

- `agent-lifecycle-contract.md`：Run、Child、Daemon、Transport 的状态机和收尾规则；
- `adr/0001-projection-settlement-failure-policy.md`：投影失败怎样保存和恢复；
- `jobs-protocol.md`：长期工作的统一状态与控制动作；
- `agent-framework-capability-boundary.md`：层与层之间的所有权边界。

需要新增：

#### `durable-execution-data-model.md`（P0）

这是当前最明显的缺口，专门回答“每条运行记录的固定格式是什么”。建议包含：

```text
Session
  -> Input
  -> Run
       -> Run Attempt
       -> Message / Part
       -> Tool Call / Tool Attempt
       -> Permission
       -> Child Task / Session Execution
       -> Workflow Run / Task Attempt
       -> Durable Event
       -> Projection Settlement
```

每种记录都要写清：

- ID 谁生成、是否允许调用方提供；
- 必填字段和可选字段；
- 与其他记录的外键或逻辑关系；
- 状态枚举和允许的状态转移；
- 哪些终态不可逆；
- 相同 ID 重试时比较哪些字段；
- 哪些写入必须放在同一个事务；
- schemaVersion、数据库 migration 和严格解码规则；
- 重启恢复、Retention 和 Inspector 怎样读取它。

现有 lifecycle 文档只定义“不变量”，daemon 文档只描述“运行流程”，protocol 类型只给 TypeScript 形状，三者都不能单独替代这份数据模型。

#### `protocol-contract.md`（P1）

集中定义：

- 当前精确协议版本 `2`；
- `/capabilities` 的 serverVersion、protocol 和 features；
- 请求、成功响应和 `ProtocolError` 的固定形状；
- 客户端何时必须先检查版本；
- snapshot 与 SSE event 的关系；
- durable cursor、transient cursor 和断线重连；
- 未知字段、未知事件、未知 schemaVersion 怎样失败；
- breaking change 怎样提升协议版本，不保留版本范围兼容。

#### `security-and-trust-boundaries.md`（P1）

集中画出：

- daemon Bearer token 保护什么；
- `ownerSession` 解决什么、不解决什么；
- Tool Permission 的请求与决定；
- Sandbox 限制模型工作负载的边界；
- provider/API key 保存位置；
- Channel/Bot ACL；
- 日志和指标禁止记录哪些敏感数据。

它不替代 Permission、Sandbox、Auth 的细节文档，只做跨模块信任边界。

### 第 2 层：子系统架构

回答：某个子系统内部有哪些对象、入口、状态和输出。

现有覆盖较好：

- Runtime：`agent-runtime-framework-architecture.md`、`agent-sdk.md`；
- Durable Application：`daemon-application-architecture.md`；
- Client：`client-sync-flow.md`；
- Workflow：`coordinator-hard-scheduler-flow.md`；
- Jobs：`jobs-protocol.md`；
- Child：`agent-child-session-flow.md`；
- Context/Memory：`context-memory-map.md`、`memory-system.md`；
- Sandbox、MCP、Plugins、Skills、Terminal 也有各自文档。

需要控制重复：Daemon 文档已经过长。等 P0/P1 文档补齐后，应把数据格式、协议、备份恢复的详细契约移到新文档，Daemon 文档只保留组合关系、请求链和链接。

### 第 3 层：端到端流程

回答：一件真实事情从入口到结果怎样走。

已有 prompt、child、permission、Bot、Workflow、Jobs、Client Sync、Sandbox、Schedule 等流程。

建议新增 `product-surface-integration.md`（P1），用同一张表说明：

| 产品入口 | 怎样调用 Application | 自己可以保存什么 | 绝对不能复制什么 |
|---|---|---|---|
| CLI/TUI | client + HTTP/SSE | 当前选择、渲染缓存 | Session/Run 权威状态 |
| Web/IDE | browser-safe client | UI state、cursor | SQLite 和 live Handle |
| Desktop | renderer client + main host capability | 窗口、PTY 展示、本机集成 | 第二份 Run/Workflow 状态 |
| Bot | Channel adapter | 平台 message/delivery ID | 独立 Agent history |
| Workflow | Application 注入的 repository + child host | DAG 计划和运行快照 | 第二套 Session/Job 真相 |

这份文档会直接回答“为什么这不是几个独立产品，而是一套 Durable Agent Application 的不同入口”。

### 第 4 层：开发和运维手册

回答：怎样调用、部署、观察和修复。

已有 SDK、Workflow CLI、slash command、daemon system service、remote attach 和 observability。

需要新增 `operations-and-recovery.md`（P0）：

- daemon 启动顺序和 ready 条件；
- Application Owner 租约、心跳、失去所有权和 stale takeover；
- 正常 shutdown 的 gate、drain、pool、store 顺序；
- 异常退出后 Run、Attempt、Tool、Permission、Child、Workflow 怎样收束；
- `unknown_outcome` 什么时候需要人工判断；
- Projection Settlement 的 retry、resolve、abandon；
- Retention 默认删什么、绝不删什么、审计在哪里；
- Backup 包含什么、怎样校验、怎样恢复到空目标；
- 常用 debug/inspect 命令和故障排查顺序。

### 第 5 层：可执行验证

回答：哪条规则由哪个测试证明。

建议新增 `contract-test-index.md`（P2），但最好由脚本检查，避免手工目录再次过期。它至少应覆盖：

- lifecycle 契约编号 → 测试文件；
- durable record → schema/migration/round-trip test；
- HTTP route → protocol validation test；
- restart/owner/backup → durability boundary test；
- packed Runtime → repository 外安装测试；
- browser client → 无 Node polyfill 构建测试。

短期可以先扩展各权威文档中的“可执行索引”，等规则数量稳定后再生成总表。

### 第 6 层：ADR、计划和历史

回答：为什么当时这样决定、实施过程怎样走。

这层不应该出现在新读者的主阅读路径里。每份历史文档必须在开头链接当前权威文档；计划完成后必须写“已完成”，不能长期保留“实施中”。

## 三项核心要求的覆盖复盘

### 1. 每条运行记录都有固定格式

当时覆盖：部分；现已补齐。

已有内容：

- `agent-lifecycle-contract.md` P1-P8 定义事务、事件版本、注册校验和 Settlement；
- `daemon-application-architecture.md` 解释 Run Attempt、Tool Attempt、Event、Workflow 和恢复；
- `@vykor/protocol` 类型和 `SessionStore` schema 定义真实字段；
- migration 和测试证明数据库格式。

完成结果：[Durable Execution Data Model](../durable-execution-data-model.md) 已集中记录关系、字段责任、ID、状态枚举和当前版本规则。

### 2. 所有运行最终都要正确收尾

当前覆盖：完整，但索引可以更醒目。

权威内容：

- Lifecycle A3-A5：Agent close 的所有阶段都要尝试；
- C2-C4：Child 失败不能留下半初始化 Handle，关闭后必须释放 lease；
- D3-D7：Run 终态不可回退，projection 失败必须补偿，shutdown 不留活动状态；
- T1-T3：Server 即使多个关闭阶段失败也要继续收尾；
- Failure Matrix：每类失败必须留下什么终态；
- Settlement ADR：durable 投影没写完时怎样跨重启继续收束。

建议：在未来的架构鸟瞰页把“终态必达”列为一级保证，并链接 Lifecycle，不要再造第二份状态机。

### 3. 限制子 Agent，防止无限扩张

当前覆盖：完整。

`agent-child-session-flow.md` 已写清：

- 默认 `maxDepth=4`；
- 默认 `maxActiveChildren=8`；
- 默认 `maxTotalChildren=64`；
- suspended 仍占 active 名额；
- close 只退 active，不退 total；
- 全树共享预算账本；
- `agent.inspect().childBudget` 可查看使用情况；
- Workflow retry 每次创建新 child，也受同一预算控制。

Lifecycle Contract 现已增加 C6，明确“创建 child 前必须通过 tree-wide budget”，并把详细计算链接到 Child Flow。预算已经从实现说明提升为跨模块契约。

## 现有文档需要补强的地方

| 文档 | 当前问题 | 建议动作 |
|---|---|---|
| `agent-lifecycle-contract.md` | Child budget 已补为 C6 | 后续改预算时同步更新 Child Flow 和测试索引 |
| `daemon-application-architecture.md` | 同时承担组合、数据模型、协议和运维，越来越长 | 新文档完成后拆出细节，只保留主链路和链接 |
| `observability.md` | 仍停留在早期 trace/log/runtime snapshot | 补 Attempt、Tool outcome、Owner、Workflow、Settlement、Retention、Backup 指标和诊断 |
| `client-sync-flow.md` | 带 phase 1/phase 2 实施口吻 | 对照当前代码更新功能状态，历史内容移到 plan/review |
| `session-storage-design.md` | 主体是退场的项目 JSON snapshot | 已标成历史；待数据模型文档完成后只保留历史入口 |
| `2026-08-22-runtime-hardening-and-operability.md` | A-D 已完成，正文仍保留当时实施语境 | 已标成完成记录；仍未处理的兼容项移入债务清单 |
| `bugs-unfixed.md` | 记录时间早，条目可能已经失效 | 逐条复核；已修复的移入历史，未修复的写当前证据和测试 |
| 多份 `*-design.md` | 没有状态，读者不知道已实现还是设想 | 统一增加状态和当前权威链接 |

## 实施结果

```text
1. architecture-overview.md（已完成）
   所有读者先使用同一张地图

2. durable-execution-data-model.md（已完成）
   固定运行记录、关系、终态和版本

3. operations-and-recovery.md（已完成）
   把长期运行、Owner、恢复、清理、备份写成可执行手册

4. protocol-contract.md（已完成）
   固定多端共同使用的协议边界

5. product-surface-integration.md（已完成）
   固定 CLI/TUI/Web/Desktop/IDE/Bot/Workflow 的接入责任

6. security-and-trust-boundaries.md（已完成）
   汇总认证、权限、Sandbox、Secret 和 Channel ACL

7. 更新 observability/client-sync/lifecycle 等现有文档（已完成）

8. 建立 contract-test-index 和自动文档检查脚本（P2，已完成）
```

每完成一份新权威文档，都要删除或缩短旧文档里的重复段落，只保留链接。否则文档数量增加了，权威性反而会下降。
