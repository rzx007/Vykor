# 渠道入站附件（飞书图片 / 文件）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。
> 设计与契约以 `docs/superpowers/specs/2026-09-20-channel-inbound-attachment-design.md` 为准；本计划只拆任务与顺序。

**目标：** 飞书机器人收到图片/文件时，下载真实字节、存入 Vykor 附件库，并作为附件交给 Agent（vision / tool_resource）。

**架构：** `FeishuAdapter` 新增 `downloadAttachment`（走 `im.messageResource.get`）；`ChannelRuntimeService` 持有并暴露一个可随连接变化更新的下载回调（方案 A）；`ChannelApplicationService` 在 `admitPrompt` 前下载 → `AttachmentService.import` → 传入 `attachments`。不动 protocol durable 类型。

**技术栈：** TypeScript、Vitest、pnpm workspace、`@larksuiteoapi/node-sdk`（动态 import）、`node:stream` `Readable.toWeb`。

## Global Constraints

- 只做入站；出站上传不做；`ChannelAttachment.data`/`url` 不得作为入站输入被信任或自行 fetch。
- 不改 `@vykor/protocol` 的 durable 类型（`DurableChannelMessageInput`、`ChannelDeliveryRecord`）。
- 失败即整条消息失败，不降级、不静默丢附件。
- 下载必须用 `im.messageResource.get`（`im.image.get`/`im.file.get` 是错的端点）。
- 线程资源用 `externalMessageId`，不得用 `platformMeta.rootMessageId`。
- 幂等：重投递同一消息必须复用已有附件引用，不产生新 asset，不 409。
- 逐任务一 commit；严格 TDD（先红后绿）。
- 只改本计划列出的文件。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `packages/channels/src/impl/feishu.ts` | `messageResource.get` 接口 + `downloadAttachment` | 修改 |
| `packages/server/src/application/channel/channel-application-service.ts` | 下载/导入/传入 admitPrompt | 修改 |
| `packages/server/src/daemon/channel-runtime-service.ts` | 下载器持有与生命周期 | 修改 |
| `packages/server/src/application/daemon-application.ts` | 装配注入 | 修改 |
| `packages/channels/src/impl/__test__/feishu.test.ts` | 下载测试 | 修改 |
| `packages/server/src/application/channel/__test__/channel-application-service.test.ts` | 导入/幂等/失败测试 | 修改 |
| `packages/server/src/daemon/channel-runtime-service.test.ts` | 下载器生命周期测试 | 修改 |
| `docs/channels-flow.md` | 入站附件说明 | 修改 |

---

## 任务 1：`FeishuAdapter.downloadAttachment`

**文件：** `packages/channels/src/impl/feishu.ts`、`packages/channels/src/impl/__test__/feishu.test.ts`

- Produces：`FeishuAdapter.downloadAttachment(input: { messageId: string; fileKey: string; type: "image" | "file" }): Promise<{ stream: ReadableStream<Uint8Array>; mimeType?: string; sizeBytes?: number }>`

- [ ] **步骤 1：编写失败的测试**
  - fake client 的 `im.messageResource.get` 应被以 `{ params: { type: "image" }, path: { message_id, file_key } }` 调用；
  - 返回对象暴露 `getReadableStream()`（Node `Readable`）与 `headers`；断言返回的是 Web `ReadableStream`（`instanceof ReadableStream` 或可 `getReader()`）；
  - `type` 透传正确（`file` 分支）；
  - 未连接（client 为 null）时抛明确错误；
  - 不调用 `im.image.get`/`im.file.get`。
- [ ] **步骤 2：运行确认失败**：`pnpm --filter @vykor/channels test -- --run src/impl/__test__/feishu.test.ts`
- [ ] **步骤 3：实现**
  - 扩展 `LarkClient`（`feishu.ts:13-34`）加 `im.messageResource.get`；
  - 用 `import { Readable } from "node:stream"` 的 `Readable.toWeb(...)` 转流；
  - 从 `headers` 尽力取 `content-type`/`content-length`，取不到留空。
- [ ] **步骤 4：运行确认通过 + Commit**（消息：`feat(channels): download feishu inbound attachments`）

---

## 任务 2：`ChannelApplicationService` 下载/导入/传入

**文件：** `packages/server/src/application/channel/channel-application-service.ts`、`packages/server/src/application/channel/__test__/channel-application-service.test.ts`

- Consumes：任务 1 的下载结果
- Produces：context 新增 `attachments: Pick<AttachmentService, "import">` 与 `downloadChannelAttachment(messageId, attachment): Promise<{ stream; name; mimeType? } | undefined>`

- [ ] **步骤 1：编写失败的测试**
  - 图片消息 → `import` 被调用、`admitPrompt` 收到 `attachments:[{assetId, intent:"vision"}]`；
  - 文件消息 → `intent:"tool_resource"`、`displayName` 取 `file_name`；
  - 下载器返回 `undefined` → 整条消息失败（明确错误）；
  - `import` 抛 `attachment_too_large` → 整条消息失败；
  - **重投递**：同一 `externalMessageId` 再次到达（`getInput` 已有附件引用）→ 复用、`import` 不再被调用、不 409；
  - `metadata.attachments` 里带 `data`/`url` 时被忽略（只读 `type`/`externalId`/`name`）。
- [ ] **步骤 2：运行确认失败**：`pnpm --filter @vykor/server test -- --run src/application/channel/__test__/channel-application-service.test.ts`
- [ ] **步骤 3：实现**
  - `handleMessageInLane`（`:90-169`）：取 `input.metadata?.attachments`（可信字段）→ 幂等查询 → 下载 → `import` → 组装 `AdmitPromptAttachmentInput[]` → 传入 `admitPrompt` 的 `attachments`；
  - `displayName` 优先级：`descriptor.name ?? download.name ?? descriptor.externalId`（飞书文件的实际文件名在 `descriptor.name`，adapter 不返回 `name`）；
  - 失败抛明确错误，不吞。
- [ ] **步骤 4：运行确认通过 + Commit**（消息：`feat(server): import feishu inbound attachments into the session`）

> **注意（红线）**：本任务把 `attachments` 与 `downloadChannelAttachment` 加为 `ChannelApplicationServiceContext` 的**必需**字段，注入发生在任务 4。因此**任务 2 与任务 4 必须一起改完再提交**，否则 `pnpm check-types` 会红（daemon 装配缺字段）。执行时把任务 2/4 视为一次提交，或先加可选字段再在任务 4 收紧。

---

## 任务 3：`ChannelRuntimeService` 持有下载器

**文件：** `packages/server/src/daemon/channel-runtime-service.ts`、`packages/server/src/daemon/channel-runtime-service.test.ts`

- Produces：`ChannelRuntimeService.downloadAttachment(messageId, attachment)`

- [ ] **步骤 1：编写失败的测试**
  - fake `createRuntime` 返回的 handle 带 `downloadAttachment`；`service.start*` 之后 `service.downloadAttachment(...)` 转发到该 handle 的实现；
  - handle 未提供 `downloadAttachment` 时返回 `undefined`；
  - `stop()` 之后返回 `undefined`（不残留已断开客户端）。
- [ ] **步骤 2：运行确认失败**：`pnpm --filter @vykor/server test -- --run src/daemon/channel-runtime-service.test.ts`
- [ ] **步骤 3：实现**
  - `ConnectorRuntimeHandle`（`:35-40`）增加可选 `downloadAttachment?(input): Promise<...>`；
  - `defaultCreateRuntime` 返回的 handle 里把 `downloadAttachment` 实现为闭包捕获的 `adapter.downloadAttachment`；
  - `startInternal` 在 `entry.handle = handle`（`:403`）之后把该实现记入服务字段；`stopInternal`（`:412-425`）清 `null`；
  - 公开 `downloadAttachment` 读该字段，空则返回 `undefined`。
- [ ] **步骤 4：运行确认通过 + Commit**（消息：`feat(server): expose channel attachment downloader on the runtime service`）

---

## 任务 4：daemon 装配

**文件：** `packages/server/src/application/daemon-application.ts`

- [ ] **步骤 1：编写失败的测试**：daemon 装配测试断言 `ChannelApplicationService` 收到 `attachments` 与 `downloadChannelAttachment`（若现有测试不便，则在 `channel-application-service.test.ts` 已覆盖行为，本步只做装配并靠 `check-types` 兜底）。
- [ ] **步骤 2：运行确认失败**
- [ ] **步骤 3：实现**：`:758-768` 注入 `attachments: this.attachments` 与闭包 `downloadChannelAttachment`。
- [ ] **步骤 4：通过 + Commit**（消息：`feat(server): wire inbound channel attachments in the daemon`）

---

## 任务 5：文档同步

**文件：** `docs/channels-flow.md`

- [ ] **步骤 1：更新**：入站附件现在会下载并落库（图片 vision / 文件 tool_resource）；出站上传仍不做；引用 spec 路径。
- [ ] **步骤 2：校验 + Commit**：`pnpm check-docs`、`git diff --check`（消息：`docs: document inbound channel attachment download`）

---

## 任务 6：阶段完整验证与人工验收

- [ ] **步骤 1：相关包全量测试**

```bash
pnpm --filter @vykor/channels test -- --run
pnpm --filter @vykor/server test -- --run
pnpm --filter @vykor/auth test -- --run
pnpm --filter @vykor/core test -- --run
pnpm --filter @vykor/tools test -- --run
pnpm --filter @rzx/ohs test -- --run
```

- [ ] **步骤 2：构建与校验**

```bash
pnpm exec turbo build --output-logs=full
pnpm check-docs
git diff --check
```

- [ ] **步骤 3：人工验收**
  1. 飞书发一张图 → Agent 能描述图片内容；
  2. 飞书发一个文件 → Agent 能读到文件内容；
  3. 同一条消息重投递不产生新 asset、不 409；
  4. 断开渠道后发附件 → 消息明确失败。

---

## 阶段完成标准

- 飞书入站图片/文件被下载并落入附件库，进入 Agent 会话。
- `@vykor/protocol` 的 durable 类型未变。
- 失败口径为整条消息失败，无降级。
- 相关包测试、类型检查、`turbo build`、`check-docs`、`git diff --check` 全绿。
