# 活跃 Agent 与事件接入

管理正在使用的 Agent，把执行事件和子 Agent 活动接回持久会话。

## 入口与流程

`AgentPool` 获取和回收实例；事件投影器接收执行事件，将消息、工具和子运行变化写回会话；恢复模块补齐尚未完成的记录写入。

子 Agent 创建事件把本次父请求的回复风格写入子会话运行配置；spawn 指定 `replyStyle` 时覆盖父请求值。重启恢复读取这份持久记录，避免子会话意外改为跟随后来的全局默认。

## 状态归属

AgentPool 与子 Agent 目录保存活跃实例；消息、运行和结算进度保存到传入的存储接口。

Daemon 为根会话启用 30 分钟空闲回收，每 30 秒检查一次；独立构造的 `AgentPool` 默认不启动定时器，宿主通过 `idleTimeoutMs` 启用，`0` 禁用。空闲从首次确认没有工作时开始计时，重新获取实例会重新计时。检查依据是实际 Agent 状态、框架的 `canSuspend()`（确认没有运行、维护或仍归框架所有的后代）、全部宿主 Jobs 和 Daemon 的运行队列、待审批/提问及后台任务记录，不使用最后一条事件的时间。Jobs 查询失败或缺少框架暂停判据时保留实例。

检查和关闭按实例依次执行，一个慢检查或慢清理会延后其他空闲实例回收。因此空闲期限是回收条件，不是硬实时截止时间；本轮保留顺序处理，避免额外并行清理状态。

回收前检查 Daemon 主人代次并取得会话独占操作权，再核实实例身份、获取次数和当前工作状态，防止新输入、维护或另一个 Daemon 接管期间关闭正在使用的实例。框架自己持有子 Agent；池只关闭自己创建的根实例。回收只关闭内存资源，不删除 Session、消息或结果；下次获取从当前持久记录重建。后台任务和仍保留的子 Agent 可让根实例长期保持热状态。

空闲关闭失败时保留隔离条目，读取不再返回可能已关闭的实例，也不创建第二个资源主人；扫描器不会反复重试。后续获取或显式关闭可重试清理，只有关闭确认成功才移除并重建。若底层框架持续返回同一个关闭错误，该会话保持隔离并向调用方报错，需修复资源清理或重启 Daemon。已有显式关闭的错误处理规则不变。定时器不阻止进程退出；Daemon 开始关闭、启动恢复失败或同步组装失败时都会停止定时检查。

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
