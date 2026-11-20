# 运行中补充实施记录

工作从三个前置修复开始，定向通过后接入目标 Run 与 Desktop 发送选择。场景编号对应[设计验收矩阵](../specs/2026-11-10-running-follow-up-design.md#9-验收矩阵)。

| 场景 | 验证入口与覆盖范围 |
| --- | --- |
| A01 | `session-interaction-service.test.ts` 在补充未被消费时验证停止到达控制层。HTTP 验收覆盖等待模型期间的同一路径。 |
| A02 | `run-coordinator.test.ts` 覆盖提升占位、恢复旧队位、取消与停止。HTTP 验收覆盖应用后结算队列 Run。 |
| A03 | Core 的 `integration.test.ts` 检查内容准备、写入历史顺序和持久化失败回滚。 |
| A04 | `approval-review-service.test.ts` 验证最新限制成为当前人工指令，原授权保留在有序历史。 |
| A05 | `checked-tool-execution.test.ts` 检查旧批准在应用版本变化后无法派发。 |
| A06 | `approval-review-service.test.ts` 检查未来、外部、Goal 和 Child 指令的权限来源。 |
| A07 | `session-interaction-service-queue-actions.test.ts` 检查 Input 或 Run 携带输出条件时原队位保留。 |
| B01–B03 | `side-chat-panel.test.tsx` 覆盖共享输入框的三档权限、计划模式和本条选择。主聊天队列生命周期、停止控件和草稿恢复分别在对应 Desktop 套件验收。 |
| B04–B05 | HTTP 验收覆盖过期目标及原 ID 重试。请求解码、接纳和队列提升用各自的定向测试覆盖输入限制。 |
| B06 | Client 同步套件与 Desktop 草稿和队列套件覆盖重复事件、快照对账和迟到回执。 |
| B07 | 侧聊套件覆盖显式目标、订阅核对、切换和删除隔离。 |
| B08 | `startup-recovery-service.test.ts` 重开 SQLite，从三种落盘状态恢复，并检查 memory 会话不写入。 |
| B09 | Client 的 `structured-delivery.test.ts` 检查 steer 能力；Desktop preload 和 HTTP 测试检查字段透传。 |
| B10 | [跨层测试](../../../tests/server-client/__test__/running-follow-up.test.ts) 验证 HTTP 接纳先于应用、后续模型请求包含补充、同一 Run 结算和工具记录唯一。 |

使用脚本化模型与本机真实 HTTP。桌面验证使用组件、store 和 IPC 测试，实际窗口的样式和真实模型供应商未纳入本轮验收。
