# 渠道入站附件（飞书图片 / 文件）设计

> 状态：待实现。
> 本文**取代** `docs/superpowers/plans/2026-09-18-channels-im-runtime-phase-2.md` 中"不下载/上传附件"的入站部分限制（见下方 §2）。

## 1. 背景与目标

现状：飞书机器人收到图片/文件消息时，`FeishuAdapter` 只解出平台标识（`image_key`/`file_key`），写进 `ChannelAttachment.externalId`，**不下载字节**（`packages/channels/src/impl/feishu.ts:156-185`）。因此：

- 图片消息的正文是空字符串，Agent 只看到"有一条空消息"，看不到图。
- 文件消息同理，Agent 不知道文件里是什么。
- `ChannelAttachment.data`/`url` 一直是空的。

目标：机器人收到图片/文件时，把**真实字节**从飞书下载到本机，存进 Vykor 附件库（`AttachmentService`），作为附件交给 Agent；Agent 用现有 vision / read 工具就能看图、读文件。

不做（本次）：出站回复附件、上传到飞书、`ChannelAttachment.data`/`url` 作为入站输入。

## 2. 声明：推翻的旧约束

`docs/superpowers/plans/2026-09-18-channels-im-runtime-phase-2.md`：

- 架构段（line 7）"出站本阶段只接受已有 Feishu media key……**不新增 upload、下载**或 durable delivery attachment 协议。"
- 禁改段（line 18）"**不把附件内容下载**或上传到本地/Feishu；入站 attachment 只携带平台稳定标识和可用元数据……"

本设计**推翻其中"入站不下载"的部分**：入站附件将被下载并落库。**"出站上传"仍然不做**，`ChannelAttachment.data`/`url` 仍不得作为入站输入被信任或自行 fetch。

## 3. 范围与硬约束

- 只做**入站**：飞书 → 本机附件库 → Agent 会话。
- **不改** `@vykor/protocol` 的 durable 类型（`DurableChannelMessageInput`、`ChannelDeliveryRecord`）。入站附件继续通过 `metadata.attachments` 透传（`packages/channels/src/core/durable-bridge.ts:104-107` 已具备）。
- 失败即**整条消息失败**（落 durable delivery failed 语义），**不降级、不静默丢附件**。
- 只信任 `ChannelAttachment` 的 `type`/`externalId`/`name`；**忽略** `data`/`url`，绝不自行 fetch。
- 不引入兼容性 fallback。
- 逐任务一 commit；严格 TDD（先红后绿）。

## 4. 飞书 API 事实（已核对 SDK）

下载**用户发来的**消息资源必须用：

```
im.messageResource.get({ params: { type: "image" | "file" }, path: { message_id, file_key } })
  -> { writeFile(path), getReadableStream(): Readable, headers }
```

- SDK 类型核对：`@larksuiteoapi/node-sdk` `types/index.d.ts` 的 `im.messageResource.get`（本机 1.60.0；仓库声明 `^1.73.0`）。文档注释：支持音频/视频/图片/文件，**≤100M**，机器人与消息需在同一会话，不支持表情包、不支持合并转发子消息。
- **不能用** `im.image.get` / `im.file.get`：它们只能下载"机器人自己上传的"资源，拿不到用户发来的图/文件。

三元组来源：

- `message_id` = `DurableChannelMessageInput.externalMessageId`（`packages/channels/src/impl/feishu.ts:227` 已保存原始 `message_id`）。
- `file_key` = `attachment.externalId`（`feishu.ts:164`/`179`）。
- `type` = `attachment.type`，只接受 `image`/`file`。

**线程**：资源属于带资源的那条子消息，用 `externalMessageId`，**不得**用 `platformMeta.rootMessageId`（那是根消息，会下错）。

## 5. 架构与接线（下载器归属 = 方案 A）

问题：`ChannelApplicationService`（`packages/server/src/application/daemon-application.ts:758`）比持有飞书客户端的 adapter（同文件 `:771` 之后的 `ChannelRuntimeService`，且运行时才创建、会重启换凭据）先存在。因此下载器**不能**是启动前塞进去的固定对象，必须是一个**由运行时服务持有、随连接变化更新**的回调。

做法（关键：经 `ConnectorRuntimeHandle` 传递，而不是在 `defaultCreateRuntime` 里直接写服务字段）：

1. `ConnectorRuntimeHandle`（`packages/server/src/daemon/channel-runtime-service.ts:35-40`）增加可选方法 `downloadAttachment?(input): Promise<...>`。
2. `defaultCreateRuntime` 创建 adapter 后，在返回的 handle 上把 `downloadAttachment` 实现为 `(input) => adapter.downloadAttachment(input)`（闭包捕获 adapter 实例）。
3. `startInternal` 在 `entry.handle = handle`（`:403`）之后，把 `handle.downloadAttachment` 记入服务的 `attachmentDownloader` 字段。
4. `stopInternal`（`:412-425`）把 `attachmentDownloader` 清 `null`，避免用已断开客户端下载。
5. 新增公开方法 `downloadAttachment(messageId, attachment)`：读该字段；未连上（字段为空 / handle 未提供该方法）返回 `undefined`（上层按失败处理）。
6. `daemon-application.ts:758` 给 `ChannelApplicationService` 注入 `downloadChannelAttachment: (messageId, att) => this.channelRuntime?.downloadAttachment(messageId, att)`（闭包延迟取值，与 `:786` 既有 `this.channelRuntime?.applyFeishuConfig` 同法，无循环依赖）。

为什么不能"在 `defaultCreateRuntime` 里直接写服务字段"：该路径只在**未注入 `createRuntime`** 时执行（`:437`），而现有测试**总是注入 fake 工厂**（`channel-runtime-service.test.ts:85`）。经 handle 传递，真实与 fake 两条路径都能生效，也满足"stop 后清空"的要求。

## 6. 数据流

```
飞书消息(image/file)
  -> FeishuAdapter._handleEvent          # 现有：解出 externalId，写入 metadata.attachments
  -> ChannelManager.handleInbound        # 现有：透传
  -> MessageBus -> DurableChannelBridge  # 现有：metadata.attachments 透传
  -> ChannelApplicationService.handleMessageInLane
       1) 取可信附件描述（type/externalId/name）
       2) 幂等：先查该 input 是否已存在且已有附件引用 -> 复用
       3) downloadChannelAttachment(messageId, attachment) -> stream
       4) attachments.import({ displayName, declaredMediaType, content }) -> assetId
       5) admitPrompt(..., { attachments:[{assetId, intent, displayName}] })
```

`intent`：图片 = `vision`；文件 = `tool_resource`。

## 7. 幂等与重投递（最高风险）

`durableChannelInputId` 只用 `connector + accountId + externalMessageId`（`packages/protocol/src/channel.ts:70-78`）。若同一消息被重复投递而每次都重新 `import`，会产生新的 `assetId`，导致 `promptAttachmentFingerprint` 变化，`admitPrompt` 抛 `prompt_id_conflict` → 409。

**必须**：导入前先 `sessionQueries.getInput(inputId)`；若已存在且已带附件引用，**复用**，不重新下载/导入。

**实际不变式（比"message_id + file_key 去重"更准确）**：飞书一条消息的资源是稳定的，且对图片/文件消息 adapter 只产出**一个** attachment；因此 `externalMessageId` 一旦确立，其附件集合就固定。复用策略依赖这个不变式：同一 `externalMessageId` 再次到达时，视为同一份附件，直接复用已有 `assetId`。

**已知边界**：若同一 `externalMessageId` 的附件描述被改动（现实中不会发生），复用策略会沿用旧 asset，**不会**报 409。这是有意的取舍——宁可用旧资源，也不要 409 把消息卡死。

复用的 `displayName` 必须与首次准入时写库的值一致（`conversation-transactions` 同时写 `displayName` 与 `metadata.requestedDisplayName`，`run-admission-service` 以 `requestedDisplayName` 重建指纹）；否则指纹不一致会 409。实现从 `SessionInputAttachmentRecord` 的 `assetId`/`intent`/`displayName` 三个字段原样重建。

## 8. 失败口径

| 情况 | 行为 |
|---|---|
| 下载器为空（渠道未连上 / 已停） | 整条消息失败 |
| 飞书下载报错 | 整条消息失败 |
| 超过 `AttachmentService.limits.maxBytesPerFile`（默认 100 MiB） | 整条消息失败（blob store 流式抛 `attachment_too_large`） |
| `admitPrompt` 失败 | 整条消息失败；已导入的 `ready` 但未被引用的 asset 由 retention 的 `gcAttachments()` 回收（注意：`AttachmentService.recover()` 只处理卡在 `importing` 的记录，不删 `ready` 孤儿） |

不"只发文字"，不跳过附件，不把 image 降级成 file/text。

**关于"不静默丢附件"**：若附件描述缺少可信 `type`/`externalId`（无法定位资源），该条消息最终会因"无正文且无附件"以 `prompt_content_required` 失败——属于失败而非降级。合法但未知的 `type`（如 `audio`）当前不在支持范围，会被跳过；由于此类消息正文为空，仍会失败，不会静默当文本处理。

## 9. 边界与非目标

- 群聊 gating 不变：`replyAtBotNames` 下群聊图片需 @机器人 才进（`feishu.ts:187-194`）。
- 文件类型闸门：本次**全收**（不照搬桌面端 PDF/Office/压缩包白名单），文件 `intent: "tool_resource"`，由 Agent 侧工具决定能否处理；将来若需收紧再另立。
- 出站回复附件、上传：**不做**。
- `apps/mcp-feishu`：非目标。
- 其他平台：非目标。

## 10. 变更文件

| 文件 | 动作 |
|---|---|
| `packages/channels/src/impl/feishu.ts` | 扩展 `LarkClient`（`messageResource.get`）；新增 `downloadAttachment` |
| `packages/server/src/application/channel/channel-application-service.ts` | context 加 `attachments` + `downloadChannelAttachment`；`handleMessageInLane` 下载/导入/传入 |
| `packages/server/src/daemon/channel-runtime-service.ts` | 下载器字段 + 赋值/清空 + 公开方法 |
| `packages/server/src/application/daemon-application.ts` | 注入 `attachments` 与下载回调 |
| `packages/channels/src/impl/__test__/feishu.test.ts` | 下载测试 |
| `packages/server/src/application/channel/__test__/channel-application-service.test.ts` | 导入/幂等/失败测试 |
| `packages/server/src/daemon/channel-runtime-service.test.ts` | 下载器生命周期测试 |
| `docs/channels-flow.md` | 补入站附件说明 |

## 11. 验收标准

- 飞书发图片 → Agent 能描述图片内容（vision）。
- 飞书发文件 → Agent 能读到文件内容（tool_resource）。
- 重复投递同一消息不产生新 asset、不 409。
- 下载失败/超限 → 消息明确失败，无降级。
- 相关包测试、类型检查、`turbo build`、`check-docs`、`git diff --check` 全绿。
- 不需要改动 `@vykor/protocol` 的 durable 类型。
