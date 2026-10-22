# P2：本地执行与 LSP 拆分记录

日期：2026-10-22。对应 T03 / M05、M06；P0–P2 已完成，P3–P6 未启动。

## 1. 迁移结果

| 原职责 | 当前唯一位置 | 说明 |
| --- | --- | --- |
| services `src/executions/` | `execution-node/src/executions/` | DetachedProcessSupervisor、ChildAgentExecutionRegistry、输出限制/日志及进程适配；测试随实现迁移 |
| services `src/lsp/` | `execution-node/src/lsp/` | 当前正则/ripgrep 实现；未扩展成真实语言服务器 |
| 模块级执行目录和默认单例 | `execution-node/src/executions/runtime-owner.ts` | 由 ExecutionRuntimeOwner 实例持有，正式提供 getDetachedProcessSupervisor / getChildAgentExecutionRegistry / withLspClient / closeScope / close |
| core 的 5 个输出日志接口 | `agent-contracts/src/shell-output.ts` | ShellOutputCapture、Host、Status、Page、SearchResult；不提前搬迁 ToolContext |
| core 的 3 个子 Agent 结果数据 | `agent-contracts/src/children.ts` | AgentChildResult、ChildPartialResult、ChildFailureKind；框架执行接口仍留至 P4 |
| services 混合测试中的执行用例 | execution-node 对应测试目录 | services 仅保留原来的 token 估算测试 |
| Sandbox 的跨包 WSL e2e | `tests/execution-node/wsl.e2e.test.ts` | 同时涉及 Sandbox、工具、MCP、PTY，避免让基础包互相依赖；根测试命令继续覆盖 |

services 根入口不再导出本地执行/LSP，`@vykor/services/executions` 子入口及旧目录已删除。tools、agent-runtime、server、CLI、测试和构建依赖全部改用实际新入口；Shell 日志工厂直接来自 execution-node，不再经 tools 转发。没有增加第三方依赖。

P0 有一条在 P2 到期的存储边界例外：附件 Blob 校验向上引用 Office 实现目录中的 ZIP 格式探测函数。将该纯函数原样归入附件的 `attachment-media-type.ts`，Office 读取器向下复用它，删除旧文件；未改 Office 运行过程。

## 2. 创建、复用和关闭责任

| 使用方式 | 谁创建 | 如何共享 | 谁关闭 |
| --- | --- | --- | --- |
| 独立 Node 根 Agent | Node 默认组装创建私有 owner | 子 Agent、Local Jobs、后台 Shell、Workflow 外部后端、LSP 工厂使用同一实例 | 根 Agent close，或初始化失败时的清理栈 |
| daemon | 默认 daemon 组装创建 owner；底层应用未收到 owner 时创建私有实例 | BackgroundShell、Jobs、执行投影、Dream、内存修改检查和默认 Node Agent 共用 | DaemonApplication.close；warm Agent 回收不关闭借用 owner |
| 直接创建 RuntimeBundle | Node Runtime 工厂在未收到 owner 时创建 | 工具注册和 LSP 调用使用此实例 | Bundle.close；构建失败时立即清理 |
| CLI 的本地 Workflow 取消入口 | 命令组合入口创建 | 通过参数传递给此次操作 | finally 中 await close |

调用方提供的 owner 表示借用；Agent 不自行关闭共享 owner。默认 daemon 向其应用转交 owner 的关闭责任。真实子 Agent 始终由 AgentChildManager 管理；观察 registry 关闭时只解除监听/回调，不另外创建或停止子 Agent。

同一 owner 内按规范 cwd/session 复用。不同 owner 的输出目录隔离，closeScope 后重新创建也使用新的资源目录，避免重复 task ID 覆盖旧日志。已有输出文件不移动、不删除；持久记录中的 outputFile 和 `shell-output://` 读取语义保留。

关闭先拒绝新获取和新进程启动，取消 LSP 请求，等待正在创建的进程交回句柄后终止，等待进程树结束及 stdout/stderr 排空。无法确认停止或排空会返回错误；一个资源关闭失败仍会等待其余资源。重复 close 返回同一个 Promise。

环境进程适配器显式登记 backend.signal 停止能力，避免把环境中的进程标识当成宿主 PID。配置检查助手在没有显式 owner 时只读取配置，不再查找或创建默认执行资源。

## 3. 边界与兼容面

- execution-node 仅依赖 agent-contracts、host-config、environment、sandbox；不依赖 core、services 或 agent-runtime。
- 8 个基础数据定义只有 contracts 一个来源，core 旧导出已删除。
- 增加禁止恢复旧 services/executions、services/src/executions、services/src/lsp 引用的检查和反例；services 不保留兼容转发入口。
- currentPhase 推进至 P2。例外从 648 降至 619：35 条已失效例外删除，6 条因同文件剩余 core 符号组缩小而精确更新；P1/P2 到期例外均为零。
- 剩余例外：P3 9、P4 571、P5 13、P6 26。旧 SessionStore 调用计数仍为 109。
- HTTP/SSE、SQLite schema 和输出/凭据协议没有升级；没有改动真实用户记录。

## 4. 验证

本轮按要求先编码、集中测试。只补跑修复或新增代码影响的测试，没有重复执行完整 workspace 测试套件。

| 范围 | 结果 |
| --- | --- |
| execution-node 全套及最终 owner 关闭补充用例 | 94 项通过，包含创建期间关闭、owner 隔离、保留旧日志、错误时等待 LSP 及最终输出排空 |
| tools Local Jobs / Workflow / LSP | 52 项通过 |
| tools 前台输出日志经 Read / Grep / Engine 回读 | 20 项通过 |
| services token / autodream | 11 项通过 |
| Office 与附件格式/存储 | 36 项通过 |
| Node 默认组装、Provider、运行集成、Kernel 和 owner 生命周期 | 88 项通过 |
| SDK 与子 Agent 跟进 | 17 项通过，含真实 PTY / Jobs / Workflow；Windows node-pty 清理曾输出 AttachConsole stderr，最终测试无失败 |
| Server 后台 Shell、执行投影、Jobs、项目重绑定、默认服务 | 134 项通过 |
| HTTP 进程树退出等待 / 配置检查 | 各 1 项通过；HTTP 按名称只选定关闭测试，其余 65 项未运行 |
| CLI Workflow | 5 项通过 |
| agent-contracts | 11 项通过 |
| 架构测试 | 37 项通过；聚合架构检查通过 |
| WSL 跨包集成 | 3 项通过、1 项因 preflight 失败跳过；取消、文件搜索、后台进程、MCP 和真实 PTY 路径已覆盖 |
| workspace 类型检查 | 67 个任务成功，包含依赖构建；最终所有权调整后 execution-node / agent-runtime / server 类型检查再通过 |
| Desktop 类型检查 | node / web / MCP Apps SDK 通过 |
| frozen lockfile | 全部 37 个 workspace 项目一致，无需重新解析依赖 |
| 最终 SDK 构建与产物冒烟 | Kernel / Node bundle 及声明构建成功；直接导入 dist 完成 Agent 创建、一次模型回合和 owner 清理 |
| 文档 / 差异格式检查 | 463 个 Markdown 文件检查通过；git diff --check 通过 |

去除重复补跑后，测试与边界检查共 510 项通过，另有 1 项 WSL 环境相关跳过；不把 HTTP 名称过滤掉的用例计入验收。

集中验证发现并修正：DreamTaskRunner 的 type 约束过宽；测试仍使用旧全局清理方式；桌面配置检查没有 live owner 时不应被强制要求创建一个。P2 开始时模型反馈已经包含独立的 Tool-Result-Id 文本块，SDK 测试夹具却把全部文本拼接后直接解析 JSON；只调整测试读取真正的 JSON 内容块，没有修改模型反馈实现。

## 5. 后续

下一阶段仍是 P3：Agent 定义、Team 和 Workflow 宿主收敛。ToolDefinition、执行上下文、Kernel/Node 的进一步拆分仍在 P4；本轮没有替代这些后续任务。
