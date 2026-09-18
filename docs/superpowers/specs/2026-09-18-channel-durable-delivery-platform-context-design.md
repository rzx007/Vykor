# 通道 durable 出站平台上下文（线程回复贯通）设计

## 1. 背景与问题

阶段二（见 `2026-09-18-channels-im-runtime-design.md` 与
`../plans/2026-09-18-channels-im-runtime-phase-2.md`）让 channels runtime 与
Feishu adapter 支持了 thread/topic 路由、入站 image/file、mention/bot 边界和能力门控。
但生产链路上仍然发不出任何线程回复。

原因不是 adapter，而是 durable 出站数据结构缺字段：

1. 生产上**唯一**的出站消息生产者是
   `DurableChannelBridge.publish()`（`packages/channels/src/core/durable-bridge.ts`）。
2. 它只能读到 `ChannelDeliveryRecord`。该协议类型没有平台路由字段
   （`packages/protocol/src/channel.ts:15-34`），数据库表 `channel_delivery`
   也没有对应列（`packages/services/src/session-runtime/schema.ts:397-431`）。
3. Feishu adapter 只有在收到 `platformMeta.rootMessageId` 时才调用
   `im.message.reply({ path: { message_id }, data: { reply_in_thread: true } })`；
   否则直接抛错（`packages/channels/src/impl/feishu.ts` 的 outbound thread 分支）。
4. 入站事件里的 `root_id` 目前只在 channels 内部被拍平进 `metadata`，
   随后落到 `session_input.metadata_json`（`channel-application-service.ts:103-115`），
   **没有**写入 conversation 或 delivery 记录。

因此：Agent 在飞书话题里生成的回复，取出时已没有根消息 id，Feishu adapter 只能
fail-closed 拒绝，线程回复不可用。fail-closed 本身符合严格契约，但功能缺失。

## 2. 目标与非目标

### 2.1 目标

- 把入站平台路由上下文（通用 `platformMeta`，Feishu 场景下含 `rootMessageId`）
  从 adapter 一路持久化到 delivery，并在「立即出站」与「重启恢复」两条路径上
  回传给 adapter，使 Feishu 线程回复真正可用。
- 保持全程严格 fail-closed：缺失字段就拒绝，不合成、不降级。
- 复用现有 `ChannelMessage.platformMeta` 语义，使未来其他平台的回复路由可复用
  同一字段，而不必再改协议。

### 2.2 非目标

- Agent 出站附件、Feishu media upload、入站媒体下载 / URL fetch。
- Telegram / Slack / Discord / 微信 / 企业微信 / 钉钉适配器。
- 修改 `ChannelMessage.threadId` 与 `ChannelMessage.platformMeta.rootMessageId`
  的既有语义，或允许二者互相冒充。
- 引入通用增量数据库迁移机制（沿用仓库既有 clean-slate 基线约定）。

## 3. 现状数据流（as-is）

```
Feishu 入站事件
  -> FeishuAdapter._handleEvent           packages/channels/src/impl/feishu.ts
       生成 ChannelMessage.platformMeta {chatType?, threadId?, rootMessageId?}
  -> ChannelManager.handleInbound         packages/channels/src/core/manager.ts
       metadata = { ...msg.metadata, _message_id, conversationId?, attachments?,
                    ...msg.platformMeta }      ← platformMeta 被拍平进 metadata
       bus.publishInbound
  -> DurableChannelBridge.handle           packages/channels/src/core/durable-bridge.ts
       metadata = { ...message.metadata, attachments? }
       application.handleChannelMessage(DurableChannelMessageInput)   ← 无 platformMeta 字段
  -> server ChannelApplicationService.handleMessageInLane
                                           packages/server/src/application/channel/
                                             channel-application-service.ts
       admitPrompt(metadata = {source:"channel", channel:{...}, ...input.metadata})
         -> session_input.metadata_json  (rootMessageId 只在此处留存)
       awaitRun -> output: string
       createDelivery(content, threadId=input.threadId)  ← 无 platformMeta
  -> channel_delivery（无 platform_meta 列）
  -> ChannelDeliveryRecord（无 platformMeta 字段）
  -> DurableChannelBridge.publish          转发 {channel, chatId, content, threadId?, metadata}
        （无 platformMeta）
  -> ChannelManager.dispatchOutbound       转发 platformMeta（若 outbound 有）
  -> FeishuAdapter.send                    无 rootMessageId -> 抛错
```

## 4. 目标数据流（to-be）

```
Feishu 入站事件
  -> FeishuAdapter._handleEvent            生成 ChannelMessage.platformMeta
  -> ChannelManager.handleInbound          复制 msg.platformMeta 到
                                           InboundMessage.platformMeta
                                           （同时保留既有拍平进 metadata 的行为，
                                             供 Agent prompt 使用）
  -> DurableChannelBridge.handle           转交 DurableChannelMessageInput.platformMeta
  -> server handleMessageInLane            createDelivery(..., platformMeta=input.platformMeta)
  -> channel_delivery.platform_meta_json
  -> ChannelDeliveryRecord.platformMeta
  -> DurableChannelBridge.publish          outbound.platformMeta = delivery.platformMeta
  -> ChannelManager.dispatchOutbound       原样转给 adapter（已实现）
  -> FeishuAdapter.send                    读到 rootMessageId -> im.message.reply(path.message_id)
```

「立即出站」与 `listPendingChannelDeliveries` 重启恢复读取同一列，行为一致。

## 5. 字段定义

### 5.1 `platformMeta`

- 类型：`Record<string, unknown>`，可选。
- 语义：平台域路由上下文，与现有 `ChannelMessage.platformMeta` 一致。
- 本阶段已知键：`rootMessageId`（Feishu `root_id`）、`threadId`、`chatType`。
- 只允许对象。数组、标量、`null` 视为非法输入并拒绝（parser 层校验）。
- 可选表示「该事件确实没有平台上下文」，**不表示**可以用其他字段猜测或补造。

### 5.2 与既有字段的关系

- `ChannelMessage.threadId` / `ChannelDeliveryRecord.threadId` 仍是 Feishu `thread_id`。
- `platformMeta.rootMessageId` 仍是 Feishu `root_id`。
- 两者不得互相冒充；出站 Feishu 只用 `platformMeta.rootMessageId` 决定 reply 目标。

## 6. 分层改动

### 6.1 protocol（`packages/protocol`）

- `ChannelDeliveryRecord` 新增 `platformMeta?: Record<string, unknown>`。
- `DurableChannelMessageInput` 新增 `platformMeta?: Record<string, unknown>`。
- `parseDurableChannelMessageInput` 解析并校验 `platformMeta`：
  仅接受普通对象；否则抛错。缺失时不写入字段。
- `ChannelDeliveryRecord` 是纯类型，无运行时构造，无需其他改动。

### 6.2 channels（`packages/channels`）

- `InboundMessage` 新增 `platformMeta?: Record<string, unknown>`。
- `ChannelManager.handleInbound` 把 `msg.platformMeta` 复制到
  `InboundMessage.platformMeta`；既有「拍平进 metadata」逻辑保留不动。
- `DurableChannelBridge.handle` 把 `message.platformMeta` 传给
  `DurableChannelMessageInput.platformMeta`。
- `DurableChannelBridge.publish` 把 `delivery.platformMeta` 传给
  `bus.publishOutbound`。
- `ChannelManager.dispatchOutbound` 已转发 `msg.platformMeta`，无需改动。
- 出站 Feishu 的 fail-closed 行为保持不变。

### 6.3 services（`packages/services`）

- `channel_delivery` 表新增 `platformMetaJson: text("platform_meta_json")`（可空）。
- `CreateChannelDeliveryInput` 新增 `platformMeta?: Record<string, unknown>`。
- `createDelivery`：提供 `platformMeta` 时写入 `encode(platformMeta)`
  （复用 `packages/services/src/session-runtime/store-state.ts` 的 `encode`），
  否则写 `null`。
- `channelDeliveryFromRow`：空列省略；有值时用**本地安全解析**（try/catch），
  非法 JSON 省略字段而不抛错，避免一条坏数据阻断 pending 列表。
  （不复用会在非法 JSON 上抛错的共享 `decode`。）
- `getDelivery` / `findDeliveryByInput` / `listDeliveries` 复用 `channelDeliveryFromRow`，
  自动带出。
- DB 基线变更见第 7 节。

### 6.4 server（`packages/server`）

- `ChannelApplicationService.handleMessageInLane` 调用 `createDelivery` 时传
  `platformMeta: input.platformMeta`。
- HTTP route（`packages/server/src/http/routes/channel.ts`）已使用
  `parseDurableChannelMessageInput`，新增字段自动可用，无需改路由。
- `pendingDeliveries` / `recordDelivery` 逻辑不变。

## 7. 数据库变更（clean-slate 重新基线）

仓库现状（`packages/services/README.md`、`docs/architecture-migration-status.md`）：

- 迁移目录只允许一份 `0000_current_schema.sql`，journal 只有一条记录；
  `scripts/verify-clean-slate.mjs` 会强制校验。
- `applySessionMigrations` 只初始化空数据库，不升级既有数据库
  （`packages/services/src/database/migrations.ts`）。
- 因此 schema 变更采用重新基线，旧数据库不在支持路径内。

具体步骤：

1. 修改 `packages/services/src/session-runtime/schema.ts`，给 `channelDelivery`
   加 `platformMetaJson`。
2. 删除并重新生成单一基线：清空 `packages/services/src/session-runtime/migrations`
   后运行 `pnpm --filter @openharness/services db:generate`，得到新的
   `0000_current_schema.sql`、`meta/_journal.json`、`meta/0000_snapshot.json`。
3. 重新追加 `INSERT INTO application_storage_format (id, version) VALUES (1, 3);`
   （历史基线以手工 INSERT 收尾，drizzle-kit 不生成数据行）。
4. 重新生成 `packages/services/src/database/__fixtures__/current-schema-inventory.json`
   （通过新基线建空库并导出 inventory），否则 `session-database.test.ts` 失败。
5. 更新 `session-database.test.ts` 对 storage format 版本与 journal 的断言（2 → 3）。
6. `pnpm check:clean-slate` 必须通过。

破坏性影响：旧 SQLite 数据库缺少新列，不在支持路径内，用户需删除或重建
（与仓库既有 clean-slate 约定一致）。

## 8. 严格性规则

- `platformMeta` 缺失时不合成 `rootMessageId`，不使用 sender / chatId / 随机 id /
  当前时间补造任何平台字段。
- 有 `threadId` 无 `platformMeta.rootMessageId` 时，仍由 **Feishu adapter** 在 send
  时 fail-closed；manager / server 不加入平台特有能力规则。
- 不做 thread → 普通 chat、image/file → text 的任何降级。
- parser 只接受对象型 `platformMeta`，非法输入拒绝。

## 9. 测试计划（TDD）

protocol：
- `parseDurableChannelMessageInput`：带合法 `platformMeta` 解析成功；数组 / 字符串 /
  `null` 被拒；缺失时结果不含该字段。

services：
- `createDelivery` + `getDelivery` + `findDeliveryByInput` + `listDeliveries`
  对 `platformMeta` 的写读 round-trip。
- 未提供 `platformMeta` 时字段省略。
- 坏 JSON / 空值不导致 `channelDeliveryFromRow` 抛错。
- 迁移基线 inventory 断言（单基线、journal、storage format 版本）。

server：
- `handleMessageInLane` 把 `input.platformMeta` 落进返回的 delivery。
- `pendingDeliveries` 返回的 delivery 带 `platformMeta`。

channels：
- `ChannelManager.handleInbound` 将 `msg.platformMeta` 复制到 `InboundMessage.platformMeta`。
- `DurableChannelBridge.handle` 把 platformMeta 传给 `handleChannelMessage`。
- `DurableChannelBridge.publish` 把 `delivery.platformMeta` 放进 outbound。
- 集成测试：Feishu 入站带 `root_id` -> 假 durable port 回带
  `platformMeta.rootMessageId` -> manager -> Feishu adapter 真正调用
  `im.message.reply({ path: { message_id: root }, data: { reply_in_thread: true } })`，
  且未调用 `im.message.create`。

## 10. 验收标准

- 上述测试全部通过。
- `pnpm --filter @openharness/protocol test -- --run`、
  `pnpm --filter @openharness/services test -- --run`、
  `pnpm --filter @openharness/server test -- --run`、
  `pnpm --filter @openharness/channels test -- --run` 全绿。
- 相关包 `check-types` 退出码 0。
- `pnpm exec turbo build --output-logs=full` 全部成功。
- `pnpm check:clean-slate` 通过。
- `git diff --check` 无格式错误。
- 不新增任何兼容性 fallback；不修改 `threadId` / `rootMessageId` 的既有语义。

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 旧 DB 不兼容 | 沿用仓库既有 clean-slate 约定，文档明确提示删除 / 重建；不实现回填 |
| 任意 JSON 存入平台字段 | parser 只接受对象；写入前 `encode`，读取时容错 |
| 恢复路径漏带字段 | `listPendingChannelDeliveries` 走同一列，集成测试覆盖恢复分支 |
| 平台语义泄漏到 server / manager | 只透传通用 `platformMeta`，Feishu 专属判断留在 adapter |
| 破坏 clean-slate 校验 | 重新基线后跑 `pnpm check:clean-slate` 作为验收项 |

## 12. 自检

- 范围是否聚焦单一问题（线程回复贯通）？是，附件与上传明确列为非目标。
- 是否保持严格 fail-closed、不引入降级？是，缺失字段仍由 adapter 拒绝。
- 是否避免平台语义泄漏到上层？是，通用 `platformMeta`，Feishu 规则留在 adapter。
- 是否覆盖立即出站与重启恢复两条路径？是，同一列 + 集成测试。
- 是否有明确验收命令与破坏性说明？是，第 7、10 节。

## 13. 后续（不在本次范围）

- Agent 出站附件 + Feishu media upload，需要新的 protocol / delivery attachment 设计。
- 入站媒体下载 / URL fetch。
- 其他 IM 平台适配器。
