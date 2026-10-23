# P5：模型尝试准入、Goal 记账和 Server 用例收敛

> 状态：2026-10-22 完成 T09、T10 / M24–M27。P0–P5 已实施，P6 待实施。对应[实施计划](../plans/2026-10-21-agent-package-convergence.md)。P4 已提交为 63c46b00；P5 已于后续任务提交为 67c3aadb，未推送。

## 1. 模型请求与 Goal 用量

agent-contracts 的 ModelAttemptGate 现在进入 AgentExecutionContext。Node 从配置接收宿主 gate，并在本轮准备时传给 Kernel；后代继承宿主配置，工具和模型不能从输入构造新的 gate。

每次实际请求按同一顺序执行：检查 limits → 等待 beforeDispatch → 可靠处理 model.attempt.started → 调用 Provider → 等待 settle → 发布 finished。主生成、重试、压缩、末轮收尾和有真实 Run 来源的记忆维护都接入。重试继续使用相同 generationId，attempt 递增；不会重放已提交的工具。

Server 新增 GoalModelAttemptService，使用持久 Run 的 session 归属和原 GoalOperations 核对 Goal 版本、暂停和预算。沿用 runId/generationId/attempt 唯一键及 complete/partial/unknown，没有新增数据库表、持久枚举或预扣 token 方案。Goal 准入与用量写入已从 DaemonAgentEventProjector 删除，投影重放不会再次记账。

- 准入拒绝不调用 Provider，也不创建已发出的结算。
- 已准入但 started 失败或取消时结算 notDispatched；真正发出但没有可靠用量时保留 unknown，继续使用现有保守预算与恢复规则。
- 结算失败直接传播，不进入 Provider 网络重试。压缩层识别原始控制错误，不能吞掉准入、可靠事件或结算失败后继续生成；普通摘要请求失败仍沿原有压缩策略处理。
- Server 准入登记成功后，若发布已保存事件失败，服务补记未发出，避免留下虚假的活动请求。
- Node 记忆维护只从已有执行来源接收 runId，从 Agent 本身重建 session/cwd/agent 身份；独立记忆、自动审查不伪造父 Run，保留既有归属。当前插件选择只验证捕获目录，没有真实模型调用，不新增虚假尝试。

## 2. Server 应用用例

| 业务 | 代码位置 | 责任 |
| --- | --- | --- |
| 存储维护 | application/maintenance/maintenance-application-service.ts | 就绪检查、重启、策略、清理、诊断、用量、备份和恢复编排；返回业务数据，抛 ApplicationError |
| 维护文件 | application/maintenance/maintenance-policy-repository.ts | 保留策略和用量配置的路径、格式检查及原子保存，保持已有文件格式 |
| 项目事实 | application/personalization/project-facts-service.ts | 脱敏、session/cwd 归属、工作区独占凭证、替换和运行时回收 |
| 便签 | application/notes/note-application-service.ts | 直接持有窄持久接口，写入前检查 ready，转换 revision 冲突和未就绪错误 |
| HTTP | http/routes/maintenance.ts、facts.ts、notes.ts | 解析请求、调用用例、转换 JSON/状态码；不再读 Store.path、文件或具体 Repository |

DaemonApplication 用具名工厂组装维护服务，注入已有 Store、Control、settings、ready 和关闭回调；没有把路由实现粘进构造函数。备份、清理、扫描和用量算法继续复用既有模块。

重启仍先持有全局独占凭证并检查活动工作，调用 closeApplication 同步停止准入，释放本次凭证后才等待关闭，finally 可重复释放。应用服务自身执行 ready 检查；HTTP 写请求也在解析正文前调用同一检查，保持旧拒绝顺序。便签未就绪继续返回 503，事实归属与 revision 冲突继续使用既有状态码。

维护路由与用例一一对应，共 23 项：

| 组 | 用例方法 |
| --- | --- |
| 状态与重启 | getReadiness、getStorageHealth、getRestartPreview、prepareRestart |
| 保留与清理 | readPolicy、updatePolicy、runPolicyCleanup、previewCleanup、runCleanup、readCleanupAudits |
| 诊断与环境 | readErrors、inspectEnvironment、readDiagnosticDetails、updateDiagnosticDetails、readLogs |
| 用量 | readUsage、readUsageSettings、addUsagePrice、updateUsageSettings |
| 存储与备份 | readStorage、createBackup、verifyBackup、restoreBackup |

## 3. 测试归属与架构检查

三个需要真实文件、客户端或 Store 的跨层请求测试分别移到 application/personalization、application/default-services、application/session/__test__；默认测试发现仍覆盖全部用例。HTTP 路由目录不再借测试长期保留文件与数据库例外。历史文档的源码路径同步更新。

架构 currentPhase 推进至 P5。P0–P5 到期例外为零，总例外从 39 降至 25，全部属于 P6：删除 P5 的 13 条，迁移测试时更新仍有效的精确 P6 路径，并删除 1 条已消失的类型关系。没有放开目录、扩大包依赖矩阵或重建白名单。SessionStore 聚合调用保持 104。

AST 反例补充了经类型别名和 Pick 包装隐藏 Store 的情况。检查器的阶段输入反例固定使用其测试阶段，不随仓库 currentPhase 前移而失效。历史界面引用清单仅更新已核对的路径和行号，不增加批准入口。

## 4. 验证证据

按要求先编码、集中验证，失败修复后只补验相关范围。

| 范围 | 结果 |
| --- | --- |
| Core 全套 | 35 个文件，438 项通过；新 gate 测试覆盖主请求/辅助请求、准入阻塞与拒绝、started 失败、取消、unknown、结算失败、重试身份和压缩错误传播 |
| services 全套 | 62 个文件，575 项通过，包含 Goal 重复报告、父子归属、晚到用量和事务恢复 |
| Node 受影响范围 | 25 文件首轮 205/206；唯一失败为 P4 遗留 MCP 断言，修正后 readiness/child-options 23/23 通过；审批审查 17/17 通过 |
| Server 扩展回归 | 252 项通过；另 1 个跨包测试文件因旧 Kernel 路径未加载，迁移其引擎与准备夹具后 8 项通过，累计覆盖 260 项 |
| 应用层补验 | 维护、事实、便签 10 文件 28 项通过；包含直接调用用例时的 ready、便签冲突、请求权限与安全重启 |
| 类型与构建 | workspace 67/67 任务通过，之后再检查最终 Server；Node/Kernel/Workflow 与声明构建通过，Kernel 为 211.7 KB |
| 独立打包安装 | Native Tool 注册/调用、默认 TerminalOpen/JobCancel、Kernel root/child/close 全部完成，命令退出 0 |
| 审查 | 独立只读审查未发现 Critical、Important 或 Minor；核对真实调用入口、控制错误、可信归属、投影只读和重启释放顺序 |
| 架构及文档 | 40 项边界测试、P5 边界、最终 pnpm check:architecture 聚合命令和 466 份 Markdown 文档检查通过，git diff --check 通过 |

两项迁移遗留随验证修正：离线但已授权的 MCP 仍可传给 child 修复认证，断言改为不出现未连接资源且认证范围只含请求服务器；跨包重试测试改用现有 Kernel 路径及显式 engine/preparation。生产授权未因测试改写而扩大。Windows PTY 辅助进程仍可能输出 AttachConsole 诊断；打包用例的行为断言和命令均成功。

主要证据入口：

- [Core gate 回归](../../../packages/core/src/engine/model/__test__/model-attempt-gate.test.ts)
- [Node gate 与记忆来源](../../../packages/agent-runtime/src/node/runtime/model-attempt-gate.test.ts)
- [Goal 服务](../../../packages/server/src/application/goals/goal-model-attempt-service.test.ts)
- [投影重放与子 Run](../../../packages/server/src/application/agent/__test__/daemon-agent-event-projector.test.ts)
- [维护重启](../../../packages/server/src/http/__test__/application-maintenance-restart.test.ts)
- [事实请求](../../../packages/server/src/application/personalization/facts.routes.test.ts)
- [便签请求](../../../packages/server/src/http/routes/notes.test.ts)

T09、T10 已完成，对应 B08、B09、B10 和本阶段 A06。P6 留待后续：清理剩余阶段例外与公开依赖面，完成最终 SDK、权威架构图和整体验收。未发布、部署或迁移真实用户数据。
