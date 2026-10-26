# Vykor 文档目录

> 状态：当前文档总入口。

先看[架构总览](./architecture-overview.md)，修改模块时进入对应主题及包 README。每类信息的维护入口、文档状态和更新规则见[文档维护约定](./documentation-policy.md)。下方将当前手册、待实施提案、历史资料分别列出，计划的完成状态以实现和验收证据核实。

## 架构与跨模块规则

| 要了解什么 | 当前文档 |
| --- | --- |
| 系统分层、入口、状态归属和依赖方向 | [架构总览](./architecture-overview.md)、[可交互架构图](./vykor-current-architecture.html) |
| 重构后的边界与持续检查 | [架构收口记录](./architecture-migration-status.md) |
| 产品如何接入共同后台 | [产品接入边界](./product-surface-integration.md) |
| Agent 执行层和持久应用如何分工 | [能力边界](./agent-framework-capability-boundary.md) |
| Run、工具、子 Agent 如何正确结束 | [生命周期契约](./agent-lifecycle-contract.md) |
| 运行记录的 ID、关系、版本和安全重试 | [持久运行数据](./durable-execution-data-model.md) |
| 数据库、记录读写与原子提交 | [Session Runtime 存储架构](./session-runtime-storage-architecture.md) |
| HTTP/SSE 请求、响应、错误和版本 | [协议契约](./protocol-contract.md) |
| 身份、凭据、授权与执行范围 | [安全与信任边界](./security-and-trust-boundaries.md) |
| 持久化失败的分类与恢复决定 | [Projection Settlement ADR](./adr/0001-projection-settlement-failure-policy.md) |

术语：daemon 是共用后台进程；Run 是一次执行；child 是子 Agent；snapshot 是某一时刻的完整状态，SSE 持续推送其后的变化；projection 是把运行事件写成持久记录与客户端状态；repository 是一类记录的读写接口。

## Agent、工具和执行环境

- [Agent SDK](./agent-sdk.md)：在程序中创建 Agent、提交消息、订阅结果与关闭资源。
- [Agent 内部架构](./agent-runtime-framework-architecture.md)：执行核心、Node 组装、Run 与状态机。
- [子 Agent 流程](./agent-child-session-flow.md)：创建、等待、继续输入、预算、关闭和持久记录。
- [Workflow 调度流程](./coordinator-hard-scheduler-flow.md)、[Coordinator Agent 定义](./coordinator-agents-design.md)：步骤依赖、并发、重试、预算与实际执行。
- [Jobs 协议](./jobs-protocol.md)：统一读取、等待、输入和取消后台工作。
- [Workflow CLI](./workflow-cli.md)：项目文件命令与 daemon SQLite 运行的区别。
- [权限流程](./permission-flow.md)：审批请求、决定、取消、三档授权与独立计划模式。
- [Native/WSL 执行流程](./sandbox-runtime-flow.md)、[运行环境与 SRT 配置](./sandbox-runtime-design.md)：文件与命令在哪里执行，以及本机可选限制。
- [模型网络重试与参数恢复](./model-network-retry-design.md)：断流、工具执行保护和重试上限。
- [上下文压缩](./compact-service-design.md)：摘要、检查点、工具配对和失败处理。
- [原生视觉图片预处理](./native-vision-image-preprocessing.md)：图片进入历史前的尺寸、大小、缓存和错误处理。

## 后台请求、同步和产品流程

- [Daemon Application 运行索引](./daemon-application-architecture.md)：输入接纳、运行、授权、子 Agent、上下文与收尾。
- [客户端同步](./client-sync-flow.md)：完整快照、SSE、游标、重连和状态合并。
- [渠道消息](./channels-flow.md)：飞书接入、身份过滤、会话映射、消息去重与回复恢复。
- [已安排任务](./scheduled-tasks-flow.md)：定时触发 Agent、保存任务与运行结果。
- [会话目标](./session-goals-design.md)：用户显式目标、续跑、用量、暂停、等待与恢复。
- [按风险自动审查](./auto-review.md)：任务结束后可选的只读代码审查，及其真实结果状态。
- [TUI 流程](./tui-flow.md)：终端界面连接 daemon、提交输入和呈现运行结果。
- [输入框能力](./composer-capabilities-requirements.md)：文本、Skill、插件、附件与上下文的当前交互。
- [Desktop 消息呈现](./desktop-agent-message-rendering.md)：消息、工具和文件变更。
- [Desktop 长对话性能](./desktop-conversation-performance.md)：职责、测量范围与复测入口。
- [Desktop 终端](./desktop-terminal-pty-design.md)：终端进程、IPC 及 Native/WSL 环境跟随。
- [Desktop 浏览器能力](./browser-capabilities.md)：页面操作、开发者模式、授权与数据范围。

## 插件、Skill、提示词和记忆

- [插件体系](./plugin-system.md)（[交互版](./plugin-system.html)）：安装、激活、Native Tool、页面与持久数据。
- [原生插件作者指南](./native-plugin-authoring.md)：清单、各类组件、打包、安装和排障。
- [插件市场](./plugin-marketplace.md)：官方及自定义 HTTPS 来源、安装、手动更新、权限和回执。
- [插件安装与贡献格式](./plugins-contributions-design.md)：Native manifest、不可变快照与外部转换。
- [插件能力调用](./plugin-capability-invocation-design.md)：选择插件后，本轮运行怎样装配并继承能力限制。
- [MCP Apps](./mcp-apps.md)（[交互版](./mcp-apps.html)）：常驻页面、工具调用、授权、回执与草稿。
- [MCP HTTP/SSE 与 OAuth](./mcp-http-transport-design.md)：传输、静态鉴权、登录、刷新和重连。
- [Claude Code 真实插件回归](./claude-real-plugin-regression.md)：固定样本的转换、安装和发现验证。
- [斜杠命令清单](./slash-commands.md)、[分流流程](./slash-commands-flow.md)：命令由客户端还是后台处理。
- [Skill 总览](./skills-flow.md)、[结构化输入流程](./skill-prompt-flow.md)：发现、选择、校验、加载和收尾。
- [上下文与记忆索引](./context-memory-map.md)：信息来源、写入位置和注入时机。
- [记忆系统](./memory-system.md)：长期记忆的读取、写入和检索。
- [提示词分层](./prompt-layering-design.md)、[提示词运行入口](./prompt-runtime-audit.md)：统一组装与当前接线。
- [个性化设置](./personalization-design.md)：用户偏好和项目环境事实。

## 使用、运维和验证

- [CLI 使用说明](../apps/cli/README.md)、[Client SDK](./client-sdk.md)：安装、参数、调用与客户端独立发布。
- [认证、Provider 和 Model](./auth-provider-model.md)：配置文件、凭据来源和解析顺序。
- [远程连接](./remote-attach.md)、[daemon 系统服务](./daemon-system-service.md)：连接发现和系统常驻。
- [运维与恢复](./operations-and-recovery.md)：启动恢复、数据目录写入者、清理、备份和格式演进。
- [开发数据重置](./development-data-reset.md)：人工预检及逐项授权的操作说明。
- [诊断与可观测性](./observability.md)：运行追踪、日志、状态快照和排障。
- [发布流程](./release-process.md)：Desktop、CLI 与官方插件的发布边界。
- [契约与测试索引](./contract-test-index.md)：按受影响规则选择自动化测试；S1 的本次验证范围见[工具操作安全验收记录](./superpowers/reviews/2026-10-26-s1-tool-operation-safety.md)。
- [跨任务行为评测](./agent-behavior-evaluation.md)：脚本场景、真实模型证据及费用授权范围。
- [真实运行验收提示词](./runtime-acceptance-prompts.md)：连接真实环境后的人工验收。

日常文档检查运行 `pnpm check-docs` 与 `pnpm check:retired-ui`。有代码改动时按影响范围增加类型检查和测试，完整命令见[根 README](../README.md#检查与发布)。

## 待实施或待评审的提案

本节描述目标与验收要求，不代表代码已经实现；不能从创建日期或文件名推断完成状态。

- [核心 Agent 能力补齐方案](./superpowers/specs/2026-10-26-agent-core-capability-completion-design.md)：S1 工具操作安全已实现；S2 可恢复执行、S3 持久审批与 P1 交付能力仍待实施。
- [桌面设置需求](./desktop-settings-requirements.md)：逐页目标行为和验收要求，具体完成范围需核对实现。
- [记忆归属与写入规则](./memory-policy.md)：记忆优化目标及验收用例。
- [真实 LSP 客户端](./lsp-client-design.md)：用语言服务器替换近似搜索的方案。

## 决策、阶段记录和历史资料

旧文件保留路径，开头链接当前说明。阶段计划只证明当时的安排，验收记录只证明当次验证的范围；历史统计和旧路径不作为当前 API。

- [阶段计划目录](./plans/README.md)、[方案与验收记录目录](./superpowers/README.md)、[研究资料目录](./research/README.md)。
- [Agent 包收敛验收](./superpowers/reviews/2026-10-21-agent-package-convergence-closeout.md)、[Protocol 分层验收](./superpowers/reviews/2026-10-22-protocol-layering-closeout.md)、[Swarm 退役与测试迁移](./superpowers/reviews/2026-10-23-swarm-retirement-and-agent-tests.md)：各阶段的代码与检查证据；后续决定以较新的实现和验收为准。
- [兼容面实施审计](./compatibility-surface-audit.md)：旧入口的删除与保留裁定。
- [插件系统交接](./plugin-system-handoff.md)、[插件后续阶段交接](./native-plugin-next-stage-handoff.md)、[插件机制调研](./plugin-mechanism-report.md)：旧阶段能力和路线快照。
- [Goal 早期复盘](./session-goals-retrospective.md)：收缩设计之前的证据和建议。
- [记忆四件套移植记录](./services-memory-quartet-design.md)、[Workflow 早期设计](./coordinator-hard-scheduler-design.md)、[Jobs 收口记录](./jobs-task-workflow-convergence.md)。
- [旧会话存储](./session-storage-design.md)、[旧 CLI 体验](./cli-experience-design.md)、[旧 TUI 渲染](./tui-render-tail-design.md)、[旧 Output Styles](./output-styles-design.md)、[旧 Skills Enhancement](./skills-enhance-design.md)、[旧 Slash Batch](./slash-batch-design.md)。
- [Desktop 流式传输历史分析](./desktop-session-streaming-performance-analysis.md)、[旧缺陷审计](./bugs-unfixed.md)、[Jobs 早期审阅](./jobs-protocol-review-2026-08-17.md)。
- [Codex Goal 实现调研](./codex-goal-implementation-research.md)、[Goal 跟进](./codex-goal-followup-2026-10-15.md)、[对话界面研究](./codex-conversation-ui-style-research.md)、[提示词研究](./codex-prompt-system-research.md)、[Windows 侧栏研究](./codex-windows-translucent-sidebar-research.md)。
- [Rome Apps](./rome-apps-analysis-report.md)、[Orkas 能力](./orkas-builtin-agents-integration-research.md)、[DeepSeek Harness 笔记](./deepseek-harness-reference-notes.md)：特定源码或版本的分析。

`workflow-scheduler-test.md` 是测试夹具，不进入产品说明。根 [PLAN-NEXT.md](../PLAN-NEXT.md) 与 [PLAN-REMAINING.md](../PLAN-REMAINING.md) 已归档；不再从它们推断当前缺口。
