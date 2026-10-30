# 活跃 Agent 与事件接入

管理正在使用的 Agent，把执行事件和子 Agent 活动接回持久会话。

## 入口与流程

`AgentPool` 获取和回收实例；事件投影器接收执行事件，将消息、工具和子运行变化写回会话；恢复模块补齐尚未完成的记录写入。

子 Agent 创建事件把本次父请求的回复风格写入子会话运行配置；spawn 指定 `replyStyle` 时覆盖父请求值。重启恢复读取这份持久记录，避免子会话意外改为跟随后来的全局默认。

## 状态归属

AgentPool 与子 Agent 目录保存活跃实例；消息、运行和结算进度保存到传入的存储接口。

`DaemonAgentEventProjector` 必须传入 `projectorId`、`rootSessionId` 与完整的结算存储接口。子 Agent 事件写入失败时，先保存待结算记录，再尝试补偿或重写关闭事件；后续事件先处理未完成结算，应用重启时由 `projection-settlement-recovery.ts` 从存储恢复。存储保存结算状态、重试次数和已处理事件依据，投影器保留当前处理序号来过滤重复事件；测试也使用同一路径。

`agent-transcript.ts` 在替换和重建历史时保存可信结果引用：只有带 `toolResultReferenceVersion: 1` 的元数据才会恢复为 `resultRef`，并校验引用形状和工具名。旧版自由工具元数据不能提升为可补读引用，原始结果正文仍由宿主操作记录保管。

`daemon-agent-event-projector.ts` 只把 Kernel `run.completed` 事件携带的真实交付回执保存到 Run 的 `metadata.delivery`。若终态事件没有回执，会清空调用方元数据中同名的交付声明，避免普通文本或自填元数据影响 Goal 结算。交付进展与 Run 是否正常结束分别保存。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [agent-pool.ts](./agent-pool.ts) | `AgentPoolSessionQueries`、`AgentPoolContext`、`AgentPool` |
| [agent-transcript.ts](./agent-transcript.ts) | `AgentTranscriptAttachment`、`AgentTranscript`、`buildAgentTranscript`、`agentMessagesToTranscript` |
| [daemon-agent-event-projector.ts](./daemon-agent-event-projector.ts) | `DaemonAgentEventProjectorContext`、`DaemonAgentEventProjector` |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |
| [live-child-agent-directory.ts](./live-child-agent-directory.ts) | `LiveChildAgentDirectory` |
| [projection-settlement-recovery.ts](./projection-settlement-recovery.ts) | `DAEMON_AGENT_PROJECTOR`、`DaemonAgentSettlementPayload`、`projectionSettlementInput`、`decodeDaemonAgentSettlement` 等 |
| [tool-app-origin-projector.ts](./tool-app-origin-projector.ts) | `ToolAppOriginProjector` |

## 测试与维护

实例复用、子 Agent 登记和执行事件转写放在这里；一次运行的业务流程放在 session/execution。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。


## 共用执行核心（阶段 A）

DaemonAgentEventProjector 是 child 持久投影的唯一入口；LiveChildAgentDirectory 只保存到真实 handle 的接线，不复制结果与运行状态。

Daemon Jobs 收到子会话 ID 后，先经 `LiveChildAgentDirectory.resolveRootSessionId` 找到根会话池中的宿主，再通过它的 `resolveSessionHost` 读取该子会话已有的实际宿主，并直接使用该宿主的 `jobs`。子会话的子任务范围、工具授权和按轮次发送由原有执行核心处理。暂停或关闭后没有可用实例时继续读取归档，查询本身不恢复实例。

阶段 B 把 run 终态与 child.closed 都交给既有 `retry-terminal-projection` 补保存；启动、输入和工具失败仍传回执行核心。旧终态保存故障不阻塞无关新事件。独立恢复补齐原 run/transcript，仅在 task.runId 匹配时更新摘要；原 delivery error 的保存确认谓词直接读取原 settlement 是否 resolved，让已修复结果可按现有上限淘汰。Shell 的 `process-terminal:<execution.id>` 载荷走同一恢复入口。

子任务终态通过内部 [child-task-result.ts](child-task-result.ts) 分别映射 output、真实 error 与 childFailure。正常保存和恢复重放共用字段规则，不从报告推导错误；恢复比较也检查错误和失败元数据。新 Run 绑定时清除旧 childFailure，旧终态只更新匹配 runId 的 Task。child.closed 携带父运行上下文，恢复时只接纳可核实的子运行报告身份或原有启动记录身份，普通 Run 由其自身终态事件修复。
