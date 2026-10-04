# 侧边聊天真正临时化：完整范围与取舍

**状态：范围评估完成，建议暂缓真正临时化。** 用户本轮授权核对范围与代价，不是修改生产代码。之前提出的“1 个存储文件、2 个测试文件”仅是内存数据库试验，不能回答本需求的接入代价，因此撤回该执行建议；不执行试验。

## 结论

现有普通侧边聊天可以继续保留：共享输入框、消息渲染、工具、选区引用和明确目标动作都有实际用途。

“关闭应用后消失、会话记录不持久保存”需要改变会话存储与应用生命周期。目前没有已经确认的小型集中入口。**不建议仅为对齐这一点，把侧边聊天扩成后端存储改造。**

这不意味着技术上做不到，也不意味着一定要改 Core 或 Agent runtime。核对结果是：普通能力在 Server/Services 装配层连接存储；可以探索在这些层隔离临时记录，但那是独立的后端能力建设，不是现有 UI 的附带小修。

## 需要保持的实际行为

- 临时侧聊可以使用普通工具、技能、插件、附件、授权与子任务，不退回纯文字模式。
- 首次获得主聊天已有历史和选段，之后不能把“继承时的历史”说成“实时同步全部左侧新结果”。
- 两边的问题、回复、停止、授权和草稿互不串会话；主任务保持运行。
- 临时记录不能通过正常历史列表、重开或恢复再次出现。
- Desktop 关闭时只结束它拥有的临时任务，不能关闭常驻 daemon 或中断主任务。
- 上传附件的缓存、用户授权创建的文件和插件业务数据不因“临时聊天”自动删除。
- 会话记忆自动写入必须明确处理；不作“所有内容绝不落盘”的隐私承诺。
- 多窗口和不同来源的侧聊仍需隔离。这里只列完整验收要求，不新增任何执行授权。

## 完整调用链与需要覆盖的文件

以下是可定位的适配/核对面，**不是每个文件都必然修改，也不是已经验证的最终改动数**。不同存储方案能合并部分适配，也可能需要新文件。不会把核对路径数包装成一个精确的“小改承诺”。

| 环节 | 现有入口或数据位置 | 真正临时化需要解决什么 |
| --- | --- | --- |
| 右侧建立与恢复 | `apps/desktop/src/renderer/src/components/desktop/tools/side-chat-panel.tsx`；`apps/desktop/src/shared/session-types.ts` | 建立临时目标；不保存可重启恢复的普通分叉关联；临时目标结束后恢复空态，保留用户尚未提交的输入 |
| 创建请求向下传递 | `apps/desktop/src/main/features/session/session-operations.ts`；`packages/client/src/types/index.ts`；`packages/server/src/http/routes/session.ts`；`packages/server/src/application/session/session-command-service.ts` | 创建时必须在复制历史之前确定存储归属，不能先创建永久分叉再把它标成临时 |
| 会话数据与正常事务 | `packages/services/src/database/session-database.ts`；`packages/services/src/database/storage-context.ts`；`packages/services/src/database/transaction-coordinator.ts`；`packages/services/src/session-runtime/store.ts`；`packages/services/src/session-runtime/store-persistence.ts` | 普通记录继续保存，临时记录独立消失；失败要同时回滚对应记录、事件与流式状态，不能改变普通库 |
| 继承主历史 | `packages/services/src/conversations/conversation-tree-operations.ts` | 原 fork 在同一 Store 中原子复制输入、消息、片段和附件引用；分开存储后要明确复制边界、失败清理与附件资产的可见性，不能重跑旧工具 |
| 流式回复及目标记录 | `packages/services/src/conversations/incremental-output.ts`；`packages/services/src/goals/goal-repository.ts` | 两者都有直接 SQL 路径；只过滤批量保存不完整，Goal 也不是一份可以直接丢弃的 UI 状态 |
| 发送、停止、授权、子任务 | `packages/server/src/application/daemon-application.ts`；`packages/server/src/application/session/session-run-assembly.ts`；`packages/server/src/application/session/session-run-executor-assembly.ts`；`packages/server/src/http/routes/permission.ts` | 当前应用向这些服务注入同一 Store；临时会话的后续操作必须找到正确记录，授权只带 requestId，不能靠给 fork 加参数自动完成 |
| 回复返回与历史列表 | `packages/server/src/http/routes/events.ts`；`packages/server/src/application/session/session-event-publisher.ts`；`packages/server/src/application/session/session-query-service.ts`；`apps/desktop/src/main/features/session/session-subscription-service.ts` | 事件、快照、重连与 cursor 必须一致；单纯隐藏 child 不等于临时化，includeChildren 仍可列出普通分叉 |
| 附件、插件和终端 | `apps/desktop/src/main/features/attachment/attachment-service.ts`；`apps/desktop/src/main/features/attachment/attachment-upload-service.ts`；`apps/desktop/src/main/features/plugin-ui/plugin-ui-service.ts`；`apps/desktop/src/main/features/terminal/terminal-service.ts`；`packages/server/src/application/attachments/resources/session-attachment-resources.ts` | 上传和资源访问有固定 Client/Store，插件 UI 校验窗口当前会话，终端事件来自普通 daemon；换存储或另开应用实例要同时覆盖这些入口，不能只让文字问答通过 |
| 关闭与记忆副作用 | `apps/desktop/src/main/features/session/session-service.ts`；`apps/desktop/src/main/features/session/daemon-connection-service.ts`；`packages/server/src/application/context-usage-live-binder.ts`；`packages/services/src/executions/runtime-registry.ts`；`packages/server/src/application/daemon-application.ts` | Desktop 退出不保证 daemon 退出；第二个应用有全局上下文绑定和全局执行关闭，还有结束后的记忆文件写入，需要隔离归属而不能清理整个进程 |

### 关键证据

1. `DesktopSessionService` 的发送、辅助订阅、授权、配置、压缩都调用同一个 `getClient()`。现有附件、插件 UI、终端也没有自动按临时存储切换的能力。
2. `createPermissionRoutes` 在授权回复中使用 `requestId`，调用固定的 `StorePermissionBroker`。第二个 Store 的权限请求不在原 broker 里。
3. `HttpEventHub` 绑定一个 `ApplicationEventService`；现有 cursor 来自该事件源。拆出一个事件空间要处理订阅归属，不可混用两份序号。
4. `TransactionCoordinator.atomic` 围绕当前一份数据库连接提交，并回滚内存记录、事件序号和增量文本状态。增加存储位置不能跳过这些保证。
5. `SessionAttachmentResources` 初始化和关闭会清理其整个资源根目录。第二个应用复用同一个目录可能影响主任务，不能只复用构造函数。
6. `closeExecutionRuntimes()` 清理进程内全部执行注册；`bindContextUsageLiveAssembler()` 只保存一个全局绑定。第二个应用不是可直接关闭的独立岛。
7. 当前 fork 的输入、消息和附件引用是普通数据，不需要改模型执行协议才能理解它们。暂未发现必须修改 `packages/core` 或 `packages/agent-runtime` 的依据；但这并不能消除上述应用层改造。

## 路线和代价

| 路线 | 能否符合真正临时化 | 代价/问题 | 建议 |
| --- | --- | --- | --- |
| 保留当前普通分叉及共享 UI | 不能；会保存为普通分支 | 无新增存储体系，现有功能和测试可继续保留 | 当前推荐，明确保存行为 |
| 只不恢复右侧 UI | 不能；后台记录仍在 | UI 小改，但不是“记录消失” | 只有用户明确只要这个体验时再做 |
| 退出时删除普通分叉 | 不能保证；记录已经落盘 | 异常退出、清理失败、长期 daemon、多窗口归属；自动删除属于额外数据风险 | 不采用 |
| 同一 Store 选择性不保存 | 有可能，但目前没有完整入口 | 中央保存之外的 SQL、事务、Goal、工作流、子任务与恢复都要覆盖 | 不作为侧边 UI 附带小修 |
| 独立内存 Store 复用现有执行能力 | 有可能，但不是现成接入 | 历史/附件复制、服务选存储、事件、关闭、全局绑定和记忆写入 | 若未来立项，作为独立存储能力评估 |

实际维护代价不是一个 bool：要长期保证“普通/临时”两种记录都能正常发送、授权、传附件、运行插件和子任务，并覆盖断连、失败、窗口关闭与重开。现有 113 项侧边/主输入回归证明 UI 和普通分叉，不证明这两种存储并存。

不估算未经实现验证的工时或精确最终文件数。已经可以确定：完整接入跨 Desktop、Client、Server、Services，不能诚实承诺只改 1 个生产文件或只改少量桌面文件。

## 最终建议与停止边界

**保留已完成的普通侧边聊天与引用标签，暂不做真正内存化。** 将“临时会话存储”从本次 UI 需求中分离；以后若它成为独立需求，再拿明确的完整范围决定是否投入。不是先做内存库试验，再自动扩成后端功能。

- 本轮只修订本文件，不执行前版存储试验，也不运行其代码。
- 不改生产代码，不删除或迁移会话，不触碰用户数据库，不提交或发布。
- 不将截图中的临时提示复制到当前持久分叉 UI。
- 不为功能对齐新增特殊 Agent 运行模式或能力限制。
- 后续若选择真正临时化，必须再次确认应用存储与服务装配的范围，不能视本次评估为实施授权。

## 审核记录

前轮独立审核已确认中央保存过滤不完整、双 Store/双应用有装配和全局关闭风险，且 Desktop 与 daemon 生命周期不同。本轮补核授权路由、事件源、附件资源目录、插件窗口归属、终端 Client、事务回滚和全局执行注册，形成上面的完整范围与不继续扩展建议。

本文件取代此前的“最小验证计划”；原存储验证任务没有执行。当前保留的生产代码仍是已验证的普通侧边聊天，未实现真正临时生命周期。
