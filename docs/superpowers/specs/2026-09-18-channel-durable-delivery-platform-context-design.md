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
3. Feishu adapter 在**有 `threadId` 但没有 `platformMeta.rootMessageId`** 时
   直接抛错；只有在拿到 `rootMessageId` 时才调用
   `im.message.reply({ path: { message_id }, data: { reply_in_thread: true } })`
   （`packages/channels/src/impl/feishu.ts` 的 outbound thread 分支）。
   没有线程上下文时走 `im.message.create`，与本文档无关。
4. 入站事件里的 `root_id` 目前只在 channels 内部被拍平进 `metadata`
   （`packages/channels/src/core/manager.ts:140-146`），随后落到
   `session_input.metadata_json`（`channel-application-service.ts:103-115`），
   **没有**写入 conversation 或 delivery 记录。

因此：Agent 在飞书话题里生成的回复，取出时已没有根消息 id，Feishu adapter 只能
按严格契约拒绝（缺字段就拒绝，不放行），线程回复不可用。这是功能缺失，不是契约缺陷。

## 2. 目标与非目标

### 2.1 目标

- 把入站平台路由上下文（通用 `platformMeta`，Feishu 场景下含 `rootMessageId`）
  从 adapter 一路持久化到 delivery，并在「立即出站」与「重启恢复」两条路径上
  回传给 adapter，使 Feishu 线程回复真正可用。
- 保持全程严格拒绝（fail-closed）：缺失字段就拒绝，不合成、不降级。
- 复用现有 `ChannelMessage.platformMeta` 语义。未来其他平台只需把各自的路由键写进
  `platformMeta`，不必再新增协议字段。

### 2.2 非目标

- Agent 出站附件、Feishu media upload、入站媒体下载 / URL fetch。
- Telegram / Slack / Discord / 微信 / 企业微信 / 钉钉适配器。
- 修改 `ChannelMessage.threadId` 与 `ChannelMessage.platformMeta.rootMessageId`
  的既有语义，或允许二者互相冒充。
- 引入通用增量数据库迁移机制（沿用仓库既有 clean-slate 基线约定）。

### 2.3 与阶段二约束的关系

阶段二计划第 17 行明确「不修改 `@vykor/protocol` 的 durable channel
input/output 类型」。本设计**取代**该限制：本阶段的核心动作就是给这两个类型增加
可选字段。除此之外，阶段二的严格契约（不降级、不伪造、thread/root 语义分离）
全部继续有效。

## 3. 现状数据流（as-is）

```
Feishu 入站事件
  -> FeishuAdapter._handleEvent           packages/channels/src/impl/feishu.ts
       生成 ChannelMessage.platformMeta {chatType?, threadId?, rootMessageId?}
  -> ChannelManager.handleInbound         packages/channels/src/core/manager.ts
       metadata = { ...msg.metadata, _message_id, conversationId?, attachments?,
                    ...msg.platformMeta }      ← platformMeta 在 manager.ts:145 被拍平进 metadata
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
  -> channel_delivery（无 platform_meta_json 列）
  -> ChannelDeliveryRecord（无 platformMeta 字段）
  -> DurableChannelBridge.publish          转发 {channel, chatId, content, threadId?, metadata}
        （无 platformMeta）
  -> ChannelManager.dispatchOutbound       转发 platformMeta（若 outbound 有）
  -> FeishuAdapter.send                    有 threadId 无 rootMessageId -> 抛错
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

### 4.1 协议版本决策（显式）

`DurableChannelMessageInput` 是 `POST /channels/messages` 的请求体，
`ChannelDeliveryRecord` 是 `/channels/status` 与 `/channels/deliveries/pending`
的返回体，二者都是受 `CURRENT_PROTOCOL_VERSION`（当前 4，
`packages/protocol/src/capabilities.ts:3`）约束的线协议。

本设计**不升级** `CURRENT_PROTOCOL_VERSION`，理由：

- 新增字段是可选的，新旧两端在 wire 上双向兼容：旧 server 会忽略多出来的
  `platformMeta`；旧 client 会忽略响应里多出来的可选字段。
- 版本号用于 client/daemon 精确握手（`protocol-middleware.ts`），本改动不改变握手语义。
- 仓库的版本号由 `verify-clean-slate.mjs:186` 硬校验为 4；无必要不触发版本迁移
  与随之而来的发布/文档联动。

如果后续把该字段改为必填、或去掉/重命名已有字段，则必须升级协议版本，并同步
`capabilities.ts`、`verify-clean-slate.mjs` 与相关文档。

**决定（已评审确认）：本次保持 `CURRENT_PROTOCOL_VERSION = 4`，不升级。**

## 5. 字段定义

### 5.1 `platformMeta`

- 类型：`Record<string, unknown>`，可选。
- 语义：平台域路由上下文，与现有 `ChannelMessage.platformMeta` 一致。
- 本阶段已知键：`rootMessageId`（Feishu `root_id`）、`threadId`、`chatType`。
- 只允许**普通对象（plain object）**。数组、标量、`null` 视为非法。
- 空对象 `{}` 等价于「没有平台上下文」，存储时按缺失处理（省略字段 / 写 `null`），
  读回时省略。
- 可选表示「该事件确实没有平台上下文」，**不表示**可以用其他字段猜测或补造。

### 5.2 与既有字段的关系

- `ChannelMessage.threadId` / `ChannelDeliveryRecord.threadId` 仍是 Feishu `thread_id`。
- `platformMeta.rootMessageId` 仍是 Feishu `root_id`。
- 两者不得互相冒充；出站 Feishu 只用 `platformMeta.rootMessageId` 决定 reply 目标。

### 5.3 命名对应

- 协议/记录层字段名：`platformMeta`。
- 数据库列 / Drizzle 属性名：`platform_meta_json` / `platformMetaJson`。

## 6. 分层改动

### 6.1 protocol（`packages/protocol`）

- `ChannelDeliveryRecord` 新增 `platformMeta?: Record<string, unknown>`。
- `DurableChannelMessageInput` 新增 `platformMeta?: Record<string, unknown>`。
- `parseDurableChannelMessageInput` 解析并校验 `platformMeta`：
  - 缺失 → 结果不含该字段；
- 普通对象解析规则：
  - 非空普通对象 → 原样返回；
  - 空对象 `{}` → 视为缺失，结果不含该字段；
  - 其他（数组 / 标量 / `null`）→ 抛错，错误信息必须包含 ` must be `，
    以便 HTTP route 映射为 4xx（`packages/server/src/http/routes/channel.ts` 只把
    含 ` is required` / ` must be ` 的错误当校验失败）。建议文案：
    `"platformMeta must be an object"`。
- `ChannelDeliveryRecord` 是纯类型，无运行时构造，无需其他改动。

### 6.2 channels（`packages/channels`）

- `InboundMessage` 新增 `platformMeta?: Record<string, unknown>`
  （`packages/channels/src/bus/queue.ts`）。
- `ChannelManager.handleInbound` 把 `msg.platformMeta` 复制到
  `InboundMessage.platformMeta`（`manager.ts:128-153`）；既有
  「拍平进 metadata」逻辑保留不动。
- `DurableChannelBridge.handle` 把 `message.platformMeta` 传给
  `DurableChannelMessageInput.platformMeta`（`durable-bridge.ts:80-105`）。
- `DurableChannelBridge.publish` 把 `delivery.platformMeta` 传给
  `bus.publishOutbound`（`durable-bridge.ts:132-146`）。
- 删除/改写 `durable-bridge.ts:137-138` 现有注释
  「rootMessageId 不在 durable delivery 协议内」——本设计后该注释失效。
- `ChannelManager.dispatchOutbound` 已转发 `msg.platformMeta`，无需改动。
- 出站 Feishu 的严格拒绝行为保持不变。

### 6.3 services（`packages/services`）

- `channel_delivery` 表新增 `platformMetaJson: text("platform_meta_json")`（可空）。
- `CreateChannelDeliveryInput` 新增 `platformMeta?: Record<string, unknown>`。
- `createDelivery`：
  - 提供且为非空普通对象时，规范化（JSON round-trip）后
    `encode(platformMeta)`（复用 `packages/services/src/session-runtime/store-state.ts`
    的 `encode`）写入；否则写 `null`。
  - 规范化失败（不可序列化，如 BigInt / 循环引用）时不抛错，写 `null` 并向上层
    暴露告警回调（若当前签名没有告警通道，则记录 `console.warn`），避免 Agent
    已执行却因 delivery 写失败而丢回复。
  - 幂等分支（同 `inputId` 已存在）保持现有行为：直接返回既有记录，不比较
    `platformMeta`（同一 inputId 下平台上下文稳定）。
- `channelDeliveryFromRow`：空列省略；有值时用**本地安全解析**（try/catch
  `JSON.parse`）并再次校验为普通对象；非法 JSON、数组、标量一律省略字段而不抛错，
  避免一条坏数据阻断 pending 列表。
  （不复用会在非法 JSON 上抛错的共享 `decode`。）

### 6.4 server（`packages/server`）

- `ChannelOperations.createDelivery` 的内联入参类型
  （`channel-application-service.ts:35-46`）新增
  `platformMeta?: Record<string, unknown>`；否则传入对象字面量会触发 TS 多余属性检查。
- `ChannelApplicationService.handleMessageInLane` 调用 `createDelivery` 时传
  `platformMeta: input.platformMeta`（`channel-application-service.ts:154-165`）。
- HTTP route（`packages/server/src/http/routes/channel.ts`）已使用
  `parseDurableChannelMessageInput`，新增字段自动可用，无需改路由。
- `pendingDeliveries` / `recordDelivery` 逻辑不变。

## 7. 数据库变更（clean-slate 重新基线）

仓库现状（`packages/services/README.md`、`docs/architecture-migration-status.md`）：

- 迁移目录只允许一份 `0000_current_schema.sql`，journal 只有一条记录；
  `scripts/verify-clean-slate.mjs` 会强制校验文件名与 journal tag。
- `applySessionMigrations` 只初始化空数据库；已有表的库直接返回、不做迁移
  （`packages/services/src/database/migrations.ts`）。
- 因此 schema 变更采用重新基线，旧数据库不在支持路径内。

具体步骤（必须逐条执行）：

1. 修改 `packages/services/src/session-runtime/schema.ts`，给 `channelDelivery`
   加 `platformMetaJson: text("platform_meta_json")`。
2. 清空 `packages/services/src/session-runtime/migrations` 后运行
   `pnpm --filter @vykor/services db:generate`。drizzle-kit 生成的是
   `0000_<随机tag>.sql`，需要：
   - 把 SQL 重命名为 `0000_current_schema.sql`；
   - 改 `meta/_journal.json`，使 `entries` 只有一条，`idx: 0`、
     `tag: "0000_current_schema"`；顶层/entry 的 `version` 字段保留 drizzle 生成值；
   - 运行 `pnpm --filter @vykor/services db:check` 检查迁移文件无冲突
     （它是迁移历史一致性检查，不是 schema 与快照等价校验；schema 正确性由第 4 步
     的 inventory 测试兜底）。
3. 在基线 SQL **末尾追加两条手工数据行**（drizzle-kit 不生成数据行）。现有基线
   `0000_current_schema.sql:434-436` 就是同样两行（当前 `version=2`），重生成后须按
   新版本号补回，并保留两条之间的 `--> statement-breakpoint`（drizzle migrator 以
   该标记切分语句；缺了它，一个 chunk 含多条语句会让 better-sqlite3 报错）：
   ```sql
   INSERT INTO application_storage_format (id, version) VALUES (1, 3);
   --> statement-breakpoint
   INSERT INTO session_event_sequence (id, reserved_through) VALUES (1, 0);
   ```
   漏掉第二条会破坏 `session_event_sequence` 的预留位，导致
   `session-database.test.ts` 失败。补完数据行后可再跑一次 `db:check`。
4. 重新生成 inventory fixture
   `packages/services/src/database/__fixtures__/current-schema-inventory.json`：
   - 用新基线建一个空库，复刻 `session-database.test.ts:19-32` 的 `inventory()`
     逻辑与 `normalize()` 空白折叠规则，导出 `{ schema, tables, format }`；
   - 覆盖 fixture。完成后删除临时脚本。
   - 退役表过滤在 `session-database.test.ts:12-17` 已是 no-op（表已不存在）。
5. 更新所有硬编码 storage format 版本 2 的断言/脚本：
   - `packages/services/src/database/session-database.test.ts:59`（`version: 2` → 3）；
   - `packages/services/src/session-runtime/__test__/store.test.ts:141,149`
     （测试名 "creates a format 2 database..." 与 `{ version: 2 }`）；
   - `packages/services/scripts/check-bundled-baseline.ts:43`
     （`version === 2` → 3）。
   - 注意：变量名是 `application_storage_format.version`；drizzle journal 自身的
     `version` 字段不随本改动变化，不要把两者混淆。
6. 更新受影响的文档中对 storage format 版本的描述
   （例如 `docs/durable-execution-data-model.md`），并用
   `rg -n "storage format|application_storage_format|version.*2" docs` 复查。
7. 运行 `pnpm check:clean-slate` 确认单基线约束通过。

破坏性影响：旧 SQLite 数据库能正常打开（`applySessionMigrations` 见已有表就返回），
但第一次 `createDelivery` 的 `INSERT ... platform_meta_json` 会报
`no such column`。旧库不在支持路径内，用户需删除或重建。

## 8. 严格性规则

- `platformMeta` 缺失时不合成 `rootMessageId`，不使用 sender / chatId / 随机 id /
  当前时间补造任何平台字段。
- 有 `threadId` 无 `platformMeta.rootMessageId` 时，仍由 **Feishu adapter** 在 send
  时拒绝；manager / server 不加入平台特有能力规则。
- 不做 thread → 普通 chat、image/file → text 的任何降级。
- 写入前规范化、读取后再校验，保证进入和流出的 `platformMeta` 一定是普通对象。

## 9. 测试计划（TDD）

protocol（`packages/protocol/src/*.test.ts` 中对应文件）：
- `parseDurableChannelMessageInput`：带合法 `platformMeta` 解析成功；数组 / 字符串 /
  `null` 被拒且错误信息含 ` must be `；缺失时结果不含该字段。

services（`packages/services/src/.../channel-*.test.ts`）：
- `createDelivery` + `getDelivery` + `findDeliveryByInput` + `listDeliveries`
  对 `platformMeta` 的写读 round-trip。
- 未提供 / 空对象时字段省略。
- 坏 JSON、数组、标量不导致 `channelDeliveryFromRow` 抛错，且字段被省略。
- 不可序列化输入不使 `createDelivery` 抛错（写 null）。
- 迁移基线 inventory 断言（单基线、journal、storage format 版本 3）。

server（`packages/server/src/application/channel/*.test.ts`）：
- `handleMessageInLane` 把 `input.platformMeta` 落进返回的 delivery。
- `pendingDeliveries` 返回的 delivery 带 `platformMeta`。

channels：
- `packages/channels/src/__test__/manager.test.ts`：`handleInbound` 将
  `msg.platformMeta` 复制到 `InboundMessage.platformMeta`。
- `packages/channels/src/__test__/durable-bridge.test.ts`：
  - `handle` 把 platformMeta 传给 `handleChannelMessage`；
  - `publish` 把 `delivery.platformMeta` 放进 outbound；
  - **恢复分支**：`listPendingChannelDeliveries` 返回带 platformMeta 的 delivery 后，
    outbound 带出同一 platformMeta。
- `packages/channels/src/impl/__test__/feishu.test.ts`：
  现有 thread outbound 测试断言完整 reply payload（`path.message_id`、
  `data.content`、`data.msg_type`、`data.reply_in_thread === true`），
  且 `create` 未被调用。
- 端到端集成测试（放在 channels 内，可新建
  `packages/channels/src/__test__/durable-thread-reply.test.ts`）：
  Feishu 入站事件带 `root_id` -> manager/bus -> 假 durable port 回带
  `platformMeta.rootMessageId` -> bridge.publish -> manager -> FeishuAdapter
  真正调用 `im.message.reply`。
  接线方式：manager 会调用 `adapter.connect()`，测试中用一个 stub 覆盖
  `FeishuAdapter.connect`（置空）并注入 mock `client`（同
  `feishu.test.ts` 的 `makeAdapter` 做法），避免真实 SDK / WS。
  假 durable port 用 `durable-bridge.test.ts` 的 `port()` 模式。

## 10. 验收标准

- 上述测试全部通过。
- `pnpm --filter @vykor/protocol test -- --run`、
  `pnpm --filter @vykor/services test -- --run`、
  `pnpm --filter @vykor/server test -- --run`、
  `pnpm --filter @vykor/channels test -- --run` 全绿。
- 相关包 `check-types` 退出码 0。
- `pnpm --filter @vykor/services db:check` 通过。
- `pnpm check:clean-slate` 通过；`pnpm check-docs` 通过。
- `pnpm exec turbo build --output-logs=full` 全部成功。
- `git diff --check` 无格式错误。
- 反 fallback 扫描（排除测试文件，只扫生产路径）无生产性伪造：
  ```
  rg -n -g '!**/*.test.ts' -g '!**/__test__/**' \
    "fallback|fall back|Date\.now\(\)|msg\.message_id \?\?|senderId .*chat_id|image.*text|file.*text|thread.*chat" \
    packages/channels/src/core packages/channels/src/bus packages/channels/src/impl/feishu.ts \
    packages/server/src/application/channel packages/protocol/src/channel.ts
  ```
  允许合法 text 分支与解释语义的注释；命中项需人工确认不是「把缺失 thread/root
  字段伪造成 chat/随机值」的实现。硬性保证以测试为准，扫描只作辅助复核。
- 明确声明：本设计取代阶段二「不改 protocol」的限制；除新增可选字段外，严格契约不变。

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 旧 DB 打开时无报错，首次 `createDelivery` 才 `no such column` | 文档明确提示删除 / 重建；不做回填；验收含 clean-slate 校验 |
| 重新基线漏掉手工数据行 | 第 7 节逐字列出两条 INSERT；用 `session-database.test.ts` 兜底 |
| drizzle 生成随机文件名 / journal tag | 第 7 节明确重命名与手写 journal |
| 版本号断言散落多处 | 第 7 节列出全部站点（session-database、store、check-bundled-baseline） |
| `platformMeta` 无界或不可序列化 | 写入前规范化并容错为 `null`；读取时对象校验；不阻断出站 |
| 任意 JSON 存入平台字段 | parser 只接受普通对象；写入前 JSON round-trip |
| 恢复路径漏带字段 | `listPendingChannelDeliveries` 走同一列，并有恢复分支测试 |
| 平台语义泄漏到 server / manager | 只透传通用 `platformMeta`，Feishu 专属判断留在 adapter |
| `platformMeta` 出现在 `/channels/status`、`/channels/deliveries/pending` 响应里 | 属可选字段且与现有 `content`/`externalMessageId` 同级，接受该可见性；不额外收紧 |

## 12. 自检

- 范围是否聚焦单一问题（线程回复贯通）？是，附件与上传明确列为非目标。
- 是否保持严格拒绝、不引入降级？是，缺失字段仍由 adapter 拒绝。
- 是否避免平台语义泄漏到上层？是，通用 `platformMeta`，Feishu 规则留在 adapter。
- 是否覆盖立即出站与重启恢复两条路径？是，同一列 + 恢复分支测试。
- 是否有明确验收命令与破坏性说明？是，第 7、10 节。

## 13. 后续（不在本次范围）

- Agent 出站附件 + Feishu media upload，需要新的 protocol / delivery attachment 设计。
- 入站媒体下载 / URL fetch。
- 其他 IM 平台适配器。
