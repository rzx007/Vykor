# 活跃 Agent 与事件接入

管理正在使用的 Agent，把执行事件和子 Agent 活动接回持久会话。

## 入口与流程

`AgentPool` 获取和回收实例；事件投影器接收执行事件，将消息、工具和子运行变化写回会话；恢复模块补齐尚未完成的记录写入。

## 状态归属

AgentPool 与子 Agent 目录保存活跃实例；消息、运行和结算进度保存到传入的存储接口。

`agent-transcript.ts` 在替换和重建历史时保存可信结果引用：只有带 `toolResultReferenceVersion: 1` 的元数据才会恢复为 `resultRef`，并校验引用形状和工具名。旧版自由工具元数据不能提升为可补读引用，原始结果正文仍由宿主操作记录保管。

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
