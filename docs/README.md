# OpenHarness 文档目录

> 状态：当前文档总入口。

这里不是按文件名堆链接，而是按“先看全局，再逐层下钻”的顺序组织。第一次了解项目从第 0 层开始；修改具体模块时，直接进入对应层级。

本目录常用词的白话含义：

- durable：状态已经写进数据库或明确的持久文件，进程退出后还能查到。
- terminal：这项运行已经结束，例如 completed、failed、interrupted 或 killed，不能再假装回到 running。
- projection：把 Agent 运行中发生的事写成数据库记录和客户端可读状态。
- repository：保存和读取某类记录的明确接口，例如 daemon 的 SQLite Workflow repository。
- contract：代码重构后也不能静默改变的硬规则。
- snapshot：某一时刻的完整状态；SSE 是服务端持续推送后续变化的连接。

## 阅读顺序

```text
第 0 层：系统鸟瞰
  整个产品由哪些层组成，CLI/TUI/Web/Desktop/IDE/Bot/Workflow 怎样共用一套能力
    ↓
第 1 层：跨模块硬规则
  哪些状态归谁、记录长什么样、运行怎样收尾、失败后怎样恢复
    ↓
第 2 层：子系统架构
  Runtime、Durable Application、Client、Workflow、Jobs、Memory、Sandbox 各自怎样工作
    ↓
第 3 层：端到端流程
  一条 prompt、一个 child、一次 permission、一个 Bot 消息实际经过哪些步骤
    ↓
第 4 层：开发和运维入口
  SDK、CLI、daemon、远程连接、排障、备份恢复怎样使用
    ↓
第 5 层：可执行验证
  每条硬规则由哪些测试证明，改动后最少要跑什么
    ↓
第 6 层：决策与历史
  ADR 解释长期决定；plans/reviews 只解释当时怎样落地
```

## 第 0 层：系统鸟瞰

1. [OpenHarness 架构总览](./architecture-overview.md)：先看 CLI/TUI/Web/Desktop/IDE/Bot/Workflow 怎样共用一套 Application 和 Runtime。
2. [可交互架构图](./openharness-current-architecture.html)：用组件图查看 Client、Application、Storage 和 Runtime 的主依赖方向。
3. [架构重构收口与当前边界](./architecture-migration-status.md)：确认 Stage 0–8 的最终结果、已删除兼容面和长期门禁。
4. [产品入口接入边界](./product-surface-integration.md)：再看每种产品自己负责什么、哪些状态必须共用。
5. [Framework 与 Durable Application 的能力边界](./agent-framework-capability-boundary.md)：继续下钻 Runtime、daemon 和产品界面的所有权。
6. [Daemon Application Architecture](./daemon-application-architecture.md)：追踪一个请求怎样进入 durable state 和 Agent Runtime。
7. [Client Sync Flow](./client-sync-flow.md)：理解 snapshot、SSE、cursor 和多端收敛。

## 第 1 层：跨模块硬规则

这一层记录“不管内部类名怎么改，都必须一直成立”的约束。

| 核心保证 | 权威文档 |
|---|---|
| 每条运行记录有稳定 ID、固定字段、版本和关系 | [Durable Execution Data Model](./durable-execution-data-model.md) |
| 每个 Run、Attempt、Tool、Child 和 Workflow 最终都进入明确终态 | [Agent Lifecycle Contract](./agent-lifecycle-contract.md)、[Projection Settlement ADR](./adr/0001-projection-settlement-failure-policy.md) |
| 子 Agent 不得无限递归、无限并发或靠关闭后重建绕过上限 | [Agent Child Session Flow：Child 预算](./agent-child-session-flow.md#child-预算防止无限叫人) |
| 相同请求可以安全重试，不同内容不能复用同一个 ID | [Durable Execution Data Model：ID 和安全重试](./durable-execution-data-model.md#id-和安全重试) |
| 已结束状态不能被迟到事件重新改回 running | [Agent Lifecycle Contract：D3](./agent-lifecycle-contract.md#daemon)、[Jobs Protocol：状态机](./jobs-protocol.md#状态机) |
| 投影失败不能假装成功，重启后要继续收束 | [Projection Settlement ADR](./adr/0001-projection-settlement-failure-policy.md)、[Agent Lifecycle Contract：P8](./agent-lifecycle-contract.md#durable-projection) |
| 一个数据目录只有一个活动 Application Owner | [Operations and Recovery：Application Owner](./operations-and-recovery.md#application-owner) |
| 客户端与服务端必须使用完全相同的协议版本 | [Protocol Contract](./protocol-contract.md) |
| 清理、备份和恢复不能留下半完成状态 | [Operations and Recovery](./operations-and-recovery.md) |
| 开发数据重置必须先解析最终路径并逐项授权 | [OpenHarness 开发数据重置手册](./development-data-reset.md) |

三条一级保证的入口：

```text
固定格式的运行记录  → durable-execution-data-model.md
所有运行正确收尾    → agent-lifecycle-contract.md 是权威契约
限制子 Agent        → agent-child-session-flow.md 的 Child 预算章节
```

## 第 2 层：子系统架构

### Agent Runtime Kernel

- [Agent Runtime 框架架构](./agent-runtime-framework-architecture.md)：Kernel 对象、创建流程、Run、事件、Handle 和状态机。
- [OpenHarness Agent SDK](./agent-sdk.md)：程序中怎样直接创建和使用 Agent。
- [Agent Child Session Flow](./agent-child-session-flow.md)：child 创建、等待、follow-up、预算、关闭和 durable 投影。
- [CompactService](./compact-service-design.md)：上下文压缩、checkpoint、Tool 配对和失败策略。
- [Prompt Layering](./prompt-layering-design.md)：系统提示词怎样分层组装。
- [Personalization](./personalization-design.md)：用户个性化设置的边界。

### Durable Agent Application

- [架构重构收口与当前边界](./architecture-migration-status.md)：Stage 0–8 的最终结果、四层边界、协议/数据基线和长期门禁。
- [Daemon Application Architecture](./daemon-application-architecture.md)：Session、Input、Run、Permission、Workflow、Owner、恢复和关闭的总入口。
- [Session Runtime 存储架构](./session-runtime-storage-architecture.md)：SQLite、Repository、Transaction、`SessionStore`、owner lease 和提交/回滚边界。
- [Durable Execution Data Model](./durable-execution-data-model.md)：所有运行记录的固定格式、关系、终态和版本。
- [Protocol Contract](./protocol-contract.md)：协议版本、请求错误、snapshot、SSE 和升级规则。
- [Client Sync Flow](./client-sync-flow.md)：HTTP client、snapshot、SSE、cursor 和 reducer。
- [Observability](./observability.md)：trace、结构化日志、runtime snapshot 和排障。
- [Scheduled Tasks Flow](./scheduled-tasks-flow.md)：定时任务怎样保存、触发、运行和记录结果。
- [Channels Flow](./channels-flow.md)：Bot/Channel 消息怎样进入同一套 durable Session/Run。
- [Daemon System Service](./daemon-system-service.md)：daemon 怎样作为系统常驻服务运行。

### Workflow、Coordinator 与 Jobs

- [Coordinator 硬调度器调用链](./coordinator-hard-scheduler-flow.md)：DAG、并发、重试、预算、repository 和 child runner。
- [Coordinator Agents](./coordinator-agents-design.md)：Coordinator 角色与 Agent 定义。
- [Jobs Protocol](./jobs-protocol.md)：Terminal、shell、Agent、dream、Workflow 的统一观察与控制协议。
- [Workflow CLI](./workflow-cli.md)：项目文件 CLI 与 daemon SQLite Workflow 的边界。
- 调度器真实测试入口统一列在 [契约与测试索引](./contract-test-index.md)；`workflow-scheduler-test.md` 只是冲突测试夹具，不是产品文档。

### Context、Memory 与 Prompt

- [Context And Memory Map](./context-memory-map.md)：进入模型上下文的信息总图。
- [原生视觉图片预处理](./native-vision-image-preprocessing.md)：图片入历史前的预检、2000px/5 MiB 限制、进程内缓存和 Provider 出口。
- [Memory System](./memory-system.md)：Memory 的读取、写入和检索。
- [Memory Quartet](./services-memory-quartet-design.md)：四类 memory service 的职责。
- [Prompt Runtime Audit](./prompt-runtime-audit.md)：prompt 运行时审计记录。

### 工具、扩展与执行环境

- [Permission Flow](./permission-flow.md)：权限请求、durable decision 和取消。
- [Agent 运行环境调用链](./sandbox-runtime-flow.md)：Native/WSL 中命令、文件和终端实际在哪里执行。
- [Native / WSL 运行环境与 SRT](./sandbox-runtime-design.md)：运行位置与本机 SRT 权限边界。
- [LSP Client 设计](./lsp-client-design.md)：把当前正则/ripgrep 近似实现替换成真实语言服务器连接，说明协议库选型、Runtime 生命周期、环境路径、权限和分阶段验收。
- [MCP HTTP Transport](./mcp-http-transport-design.md)：MCP HTTP/SSE 与鉴权。
- [OpenHarness 原生插件与外部转换器设计](./superpowers/specs/2026-08-25-native-plugin-and-converters-design.md)：Native Plugin 唯一运行时契约，以及 Claude Code、Codex 等外部格式的独立转换设计。
- [OpenHarness 插件系统最终形态交接](./plugin-system-handoff.md)：面向后续开发者说明最终用户形态、Native Plugin 契约、转换与安装边界、当前完成度和建议实施顺序。
- [原生插件开发第一阶段设计](./superpowers/specs/2026-09-09-native-plugin-authoring-v1-design.md)与[实施计划](./superpowers/plans/2026-09-09-native-plugin-authoring-v1.md)：公开开发类型、五类组件指南、文本检查参考插件及真实调用和生命周期验收。
- [Desktop 本地 Native Plugin 包导入](./superpowers/specs/2026-09-09-desktop-native-plugin-zip-import-design.md)与[实施计划](./superpowers/plans/2026-09-09-desktop-native-plugin-zip-import.md)：插件页面当前可选择一个本地 Native `.zip`、`.tar`、`.tar.gz` 或 `.tgz`，后台校验后直接安装或进行一次权限确认；Git URL 安装已完成实现与真实仓库验收，npm、归档 URL 和 Marketplace 仍未进入 Desktop。
- [Native Plugin 重新安装核心设计](./superpowers/specs/2026-09-10-native-plugin-reinstall-core-design.md)与[实施计划](./superpowers/plans/2026-09-10-native-plugin-reinstall-core.md)：重新导入同一插件 ID 的 Native 插件包完成手动更新或修复，只在新增权限时重新确认，并保留旧记录到新快照成功切换。
- [Native Plugin Runtime 诊断 v1](./superpowers/specs/2026-09-14-native-plugin-runtime-diagnostics-v1-design.md)与[实施计划](./superpowers/plans/2026-09-14-native-plugin-runtime-diagnostics-v1.md)：Plugin Service 返回 `runtimeStatus`，Desktop 插件页显示已禁用、待生效、已加载、部分可用或加载失败，并给出一条建议动作。
- [Native Plugin 后续工作交接](./native-plugin-next-stage-handoff.md)：运行诊断 v1、作者体验小修和 Git 来源完成后的接手说明；Agent 对话安装、`output_styles`、自动更新、Marketplace、npm 和归档 URL 继续暂缓。
- [Native Plugin v1 与 Claude Code Converter 实施计划](./superpowers/plans/2026-08-25-native-plugin-and-claude-converter.md)：按 Native schema、安装激活、格式硬切、Converter core 和 Claude 转换闭环拆分的可执行任务。
- [Native Plugin 当前实现](./plugins-contributions-design.md)：当前 Native Plugin 的 manifest、安装快照、外部转换、Runtime 激活和安全边界。
- [插件能力召唤与运行设计](./plugin-capability-invocation-design.md)：`@插件` 选择后，Skill、MCP、Native Tool 和 Agent 怎样按当前 Run 装配、执行和继承权限。
- [原生插件开发指南](./native-plugin-authoring.md)：公开 Tool 类型、Plugin Agent、参考插件、五类组件写法、Desktop 本地插件包导入、安装调试与当前能力边界。
- [Claude Code 真实插件回归](./claude-real-plugin-regression.md)：用固定 commit 的真实 Claude Code 插件样本验证 detect、convert、install 和 Runtime discover 全链路。
- [Slash Commands](./slash-commands.md) 与 [Slash Command Flow](./slash-commands-flow.md)：当前命令清单、三层分流和执行入口。
- [Skills Flow](./skills-flow.md) 与 [Skill Prompt Flow](./skill-prompt-flow.md)：Skill 的发现、可见性，以及结构化 Skill 输入从发送到 Run 收尾。

### 产品界面

- [Product Surface Integration](./product-surface-integration.md)：各种上层产品共同使用 Application 的规则。
- [输入框能力需求](./composer-capabilities-requirements.md)：`@`、`+`、Slash、Skill、附件与上下文选择的当前契约。
- [会话目标设计](./session-goals-design.md)：目标输入、持久状态、自动续跑、验收与恢复规则。
- [Goal 实现复盘](./session-goals-retrospective.md)：Codex 开源实现对照、当前缺口与调整顺序。
- [TUI Flow](./tui-flow.md)：TUI 怎样连接 daemon 和渲染运行状态。
- [Desktop Agent Message Rendering](./desktop-agent-message-rendering.md)：Desktop 消息和文件变更展示。
- [Desktop Terminal PTY](./desktop-terminal-pty-design.md)：Desktop 终端、PTY、IPC 和 Native/WSL 环境跟随。

## 第 3 层：端到端流程

按实际问题找文档：

| 想追踪的流程 | 文档 |
| --- | --- |
| 用户发送 prompt，直到 Run 和 transcript 收尾 | [Daemon Application Architecture：TUI 发送 hi](./daemon-application-architecture.md#tui-发送-hi) |
| 用户发送带 Skill 的 prompt，直到工具加载和 Run 收尾 | [Skill Prompt Flow](./skill-prompt-flow.md) |
| child Agent 创建、运行、继续输入和关闭 | [Agent Child Session Flow](./agent-child-session-flow.md) |
| Tool 请求权限，UI 回复，Run 继续 | [Permission Flow](./permission-flow.md) |
| Bot 收消息、幂等执行、发送或重试回复 | [Channels Flow](./channels-flow.md) |
| Workflow 拆任务、调度、持久化和恢复 | [Coordinator 硬调度器调用链](./coordinator-hard-scheduler-flow.md) |
| Job 创建后怎样 read/wait/send/cancel | [Jobs Protocol](./jobs-protocol.md) |
| 客户端首次同步、断线重连和去重 | [Client Sync Flow](./client-sync-flow.md) |
| Agent 在 Native/WSL 中怎样启动和停止进程 | [Agent 运行环境调用链](./sandbox-runtime-flow.md) |
| 定时任务到点后怎样启动 Agent | [Scheduled Tasks Flow](./scheduled-tasks-flow.md) |
| TUI 怎样 attach daemon | [TUI Flow](./tui-flow.md) |

## 第 4 层：开发和运维入口

- 直接嵌入 Agent：[OpenHarness Agent SDK](./agent-sdk.md)
- 使用 Workflow 文件 CLI：[Workflow CLI](./workflow-cli.md)
- 使用 slash command：[Slash Commands](./slash-commands.md)
- 远程连接 daemon：[Remote Attach](./remote-attach.md)
- 安装和管理常驻 daemon：[Daemon System Service](./daemon-system-service.md)
- 发布 Desktop 和 CLI：[Desktop 与 CLI Tag 发版](./release-process.md)
- 配置认证、Provider 和 Model：[Auth、Provider、Model](./auth-provider-model.md)
- 查看 trace、metrics 和运行诊断：[Observability](./observability.md)
- 处理启动恢复、Owner、Retention 和备份：[Operations and Recovery](./operations-and-recovery.md)
- 检查认证、权限和 Sandbox 边界：[Security and Trust Boundaries](./security-and-trust-boundaries.md)

## 第 5 层：可执行验证

- [真实运行验收提示词](./runtime-acceptance-prompts.md)：把典型用户输入直接发给真实模型，人工核对 Run、Tool、Child、Job、Permission、Workflow、Memory、Bot 和 Schedule 是否真的工作。
- [契约与测试索引](./contract-test-index.md)：把 Runtime、durable 数据、协议、Client、Workflow、Jobs、Channel、Permission 和 Sandbox 的硬规则映射到具体测试文件。
- `pnpm check-docs`：检查文档状态、总目录必备入口和所有本地 Markdown 链接。
- `pnpm check-types`：检查跨包 TypeScript 接口。
- `pnpm test`：运行当前工作区测试。
- `pnpm test:client-browser`：确认共享 client 能在浏览器构建，不依赖 Node polyfill。

## 第 6 层：决策、计划和历史

- `docs/adr/`：已经作出的长期决定。当前有 [Projection Settlement 失败分类与恢复边界](./adr/0001-projection-settlement-failure-policy.md)。
- `docs/plans/`：阶段实施计划和完成记录，不是当前 API 手册。
- `docs/superpowers/plans/`、`docs/superpowers/specs/`：更细的历史实施过程。
- 文件名包含 `review`、`notes` 或明确标为“历史设计”的文档：用于解释过去，不用于决定当前 API。
- [Compatibility surface 实施审计](./compatibility-surface-audit.md)：Stage 8 删除/保留裁定的实施证据，不是当前 API 清单。
- [Session 存储增强历史设计](./session-storage-design.md)：已经退场的项目级 JSON snapshot 设计；当前 SQLite 边界见 [Session Runtime 存储架构](./session-runtime-storage-architecture.md)。
- [Output Styles 历史设计](./output-styles-design.md)、[Skills Enhancement 历史设计](./skills-enhance-design.md)、[Slash Batch 历史设计](./slash-batch-design.md)：保留迁移前背景，当前入口以各文档状态栏指向的新文档为准。

当前文档、ADR、计划和历史发生冲突时，优先级是：

```text
当前代码、migration、自动化测试
  > 标为“权威契约 / 当前实现”的文档
  > ADR
  > plans、specs、reviews 和历史设计
```

## 当前格式策略

项目已经删除旧 API 别名、re-export façade、字段别名和旧数据读取路径。当前版本只接受当前接口和当前数据格式：

- SQLite 迁移以 `0000_current_schema.sql` 为基线，其后为增量迁移链，启动时按 `__drizzle_migrations` 水位线自动应用；
- 基线前旧库由基线快照一次性接管补齐（只做可加性变更：补列、建索引、清理废弃表），再应用增量迁移；不做字段猜测或读取时降级；
- event、settings、Session snapshot、Memory 和 Swarm 文件都有明确版本标记；
- 需要版本标记的数据缺失标记或版本不同时直接失败；声明为必填的字段缺失或字段名过时时直接失败；
- schema 演进与旧库接管见 [Operations and Recovery](./operations-and-recovery.md#schema-演进与旧库接管)。

## 写文档时的约定

- 当前文档先讲入口、关键步骤、状态放在哪里、结果从哪里返回，再讲类型名。
- 第一次出现英文术语时，要同时解释它实际做什么。
- 一条跨模块硬规则只指定一份权威文档，其他地方链接过去，不复制整段契约。
- 每份当前文档开头必须标明“当前实现”或“权威契约”；计划和历史资料也必须明确状态。
- 修改公开入口、持久化格式、协议版本、状态机或所有权边界时，必须同步更新本目录和对应权威文档。
- 修改 Client Resource、Server Application Service、Repository/Transaction 或 Runtime 所有权时，同时核对架构总览、对应专题文档、根 README 和 `openharness-current-architecture.architecture.json` 图源。
- 不增加兼容代码来维持过时文档。
