# Desktop 会话流式输出传输性能分析

**分析日期：** 2026-10-08  
**范围：** Desktop 会话事件从 daemon 经主进程到 Renderer 的传输与状态更新。  
**证据类型：** 当前检出源码静态追踪；尚未采集本机运行时性能记录。

## 结论

当前实现有一段明确的全量数据路径：主进程接收 SSE 事件并更新 client reducer，然后以 50ms 固定窗口合并状态；每次窗口交付时，主进程重新构建 `DesktopSessionView`，再通过 Electron IPC 发送给 Renderer。视图构建会复制输入、排序全部消息、展平并排序所有 parts，再映射为 Desktop 类型。[订阅和 IPC 推送](../apps/desktop/src/main/features/session/session-subscription-service.ts#L177) [完整视图构建](../apps/desktop/src/main/features/session/session-subscription-service.ts#L264)

因此，流式期间的可见传输成本随当前会话视图大小增长。IPC 有序列化和跨进程搬运成本，但仅凭源码还不能断定它是当前掉帧的首要来源；Renderer 收到更新后仍要对账 store、更新消息组件并绘制界面。[Renderer 会话更新](../apps/desktop/src/renderer/src/stores/desktop-session/session-view-actions.ts#L27)

建议优先保留完整快照用于打开会话和恢复同步，将高频的 `session.message.part.delta` 改为小型文本追加消息，并沿用当前 50ms 合并窗口。这样先减少主进程反复构建完整视图和跨 IPC 发送历史数据的工作，不改变现有显示节奏，也不把 daemon 连接和凭据移到 Renderer。

## 当前实际链路

1. Desktop 主进程持有 `VykorClient`，通过 `syncEvents` 获取 daemon 的快照和 SSE 事件。同步更新同时包含原始事件和归并后的 client state。[`SyncEventUpdate`](../packages/client/src/types/sync-types.ts#L52)
2. `SessionSubscriptionService.pumpSession` 为每个会话订阅建立 50ms 固定窗口合并器。流式正文事件也进入该窗口；代码当前跳过正文 delta 的是插件 UI 所有权快照监听器，正文 delta 仍会进入会话视图推送路径。[事件处理和合并](../apps/desktop/src/main/features/session/session-subscription-service.ts#L225) [50ms 窗口](../apps/desktop/src/main/features/session/session-subscription-service.ts#L29)
3. 窗口交付时调用 `toDesktopSessionView`，构建完整会话视图，再调用 `webContents.send(IpcEvents.sessionUpdated, view)`。[IPC 推送](../apps/desktop/src/main/features/session/session-subscription-service.ts#L196) [视图构建](../apps/desktop/src/main/features/session/session-subscription-service.ts#L264)
4. Preload 把 `sessionUpdated` 作为 `sessions.onUpdated` 暴露给 Renderer；Zustand store 调用 `applySessionUpdate`，对账运行时状态并设置新的 `sessionView`。[Preload 订阅](../apps/desktop/src/preload/desktop-api.ts#L585) [Store 对账](../apps/desktop/src/renderer/src/stores/desktop-session/session-view-actions.ts#L27)

50ms 合并意味着每个订阅最多约每秒 20 次完整视图交付，而不是每个 token 各发一份视图。主进程仍会逐事件运行 reducer；合并器只合并视图交付，不会跳过事件归并。

## 参照项目的做法

### T3 Code

T3 的 Desktop/Web 客户端通过 WebSocket RPC 消费线程事件，不经 Electron 主进程逐条转发。默认 `paragraph` 流式模式会等待完整段落或代码块边界，并限制同一消息的频繁更新；发出的 assistant 文本事件仍包含当前已准备好的累计文本前缀。对照源码位于本机 T3 仓库 `D:\code\personal-project\t3code`：`apps/server/src/orchestration-v2/assistantStreaming.ts`、`apps/server/src/ws.ts`。

这说明其分块显示同时受传输和产品流式策略影响。它的段落节奏不适合作为本项目的默认改动，因为我们现有界面以更细的文本增量显示。

### ZCode

ZCode Desktop 通过 MessagePort RPC 连接 Renderer 和窗口级 Host。主进程创建并移交端口；文本事件不需要每次经过主进程的 IPC handler。对照源码位于本机 ZCode 仓库 `D:\code\personal-project\ZCode`：`packages/desktop/src/main/desktopHostProcess.ts`、`packages/desktop/src/renderer/src/main.tsx`。

ZCode 将模型 `text_delta` 编码成带目标行 ID 的 `row.delta`，载荷只携带新增文字；相邻同一行的追加会合并。Desktop `continuous` profile 默认每 30ms 刷出增量帧，快照留给首次同步和恢复。对照源码位于该仓的 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`、`packages/shared/src/zcode-protocol-v4/coalesce.ts` 和 `packages/shared/src/zcode-protocol-v4/core.ts`。

对本项目最可复用的经验是**保留 IPC 边界，缩小高频消息载荷**。改变传输协议比去掉 Electron IPC 更直接地针对当前全量视图路径。

## 建议的最小改造

1. 会话打开、重连和明确的同步恢复继续发送完整 `DesktopSessionView`。
2. 对 `update.event.type === "session.message.part.delta"`，从已有事件中提取目标 `sessionId`、`messageId`、`partId`、字段和新增文本；在现有 50ms 窗口内按目标合并后发送小型追加更新。当前主进程已经能识别该事件类型，无需重新从累计快照推导文本差异。
3. Renderer 按稳定的 message/part ID 追加文本，只更新目标 part；完整快照仍用于建立或重置基线。更新必须带同步水位，遇到旧更新或无法匹配的基线时丢弃增量并恢复完整快照。
4. 第一阶段只替换正文 delta 的传输；其他事件先沿用现有快照路径。后续是否扩展到工具进度或子代理状态，依据运行时记录中每类事件的成本决定。

改造保持 50ms 合并窗口，预期的文本更新频率与当前一致；重点减少每次推送的视图构建和 IPC 载荷，而不靠延迟正文来换取流畅度。

## 运行时需要确认的指标

静态代码只能确认存在全量视图构建和传输，不能测出它们占总掉帧的比例。实现前后应记录同一运行场景中的：

- 主进程收到事件、完成 `toDesktopSessionView`、调用 IPC 的耗时与次数。
- 单次 IPC 视图的序列化大小，以及 delta 方案的帧数和字节数。
- Renderer 收到消息、执行 `applySessionUpdate` 或 delta reducer 的耗时。
- 活跃对话的 React commit 和长任务；同时观察 Markdown 渲染时间。

如果传输和视图构建明显下降而掉帧基本不变，应继续查 Renderer 的消息渲染、布局或 Markdown 路径。左侧菜单折叠卡顿涉及另一段布局链路，不能仅凭本报告的会话同步代码归因。

## 限制

本报告是源码链路分析，不是运行时性能结论。它没有证明 Electron IPC 是唯一或最大的瓶颈，也没有声称增量传输能单独解决所有界面掉帧。T3 Code 和 ZCode 的代码用于说明可选的消息模型，不是本项目性能结果的替代测量。
