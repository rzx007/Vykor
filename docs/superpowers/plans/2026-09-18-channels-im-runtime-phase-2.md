# 通道 IM Runtime 阶段二实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在阶段一严格文本契约之上，为 channels runtime 和 Feishu adapter 增加可验证的 image/file attachment、thread/topic 路由和 mention/bot 过滤语义，同时保持上层业务协议不变。

**架构：** 附件先在 channels runtime 内完成统一传输：Feishu 事件映射为 `ChannelAttachment`，MessageBus 负责携带附件，ChannelManager 在已声明能力范围内做能力校验和路由，DurableChannelBridge 将入站附件描述放入既有 metadata。出站本阶段只接受已有 Feishu media key，直接生成真实 image/file payload；不新增 upload、下载或 durable delivery attachment 协议。字段缺失、能力不匹配、线程目标不完整时直接拒绝，不做 text/file/thread fallback。

**技术栈：** TypeScript、Vitest、pnpm workspace、Feishu Node SDK、MessageBus、ChannelManager、DurableChannelBridge

---

## 范围与禁止项

- 本阶段只实现 Feishu 的 image/file、thread/topic、mention/bot 语义。
- 不接入 Telegram、Slack、Discord、微信、企业微信或钉钉。
- 不修改 `@openharness/protocol` 的 durable channel input/output 类型；入站附件通过 channels 内部字段和 durable metadata 透传，但本阶段不承诺 Agent 通过 durable delivery 生成附件回复。
- 不把附件内容下载或上传到本地/Feishu；入站 attachment 只携带平台稳定标识和可用元数据，出站 attachment 只接受已有 Feishu media key。
- `ChannelAttachment.data`、`url` 在本阶段不是 Feishu 出站输入；出现时必须明确拒绝，不能自行 fetch 或猜测编码。
- 不把 image 降级为 file，不把 file 降级为 text，不把 thread 降级为普通 chat。
- 不使用 `sender`、`chatId`、随机 ID 或当前时间伪造缺失的平台字段。

---

## 任务 1：扩展附件传输并增加能力校验

**文件：**
- 修改：`packages/channels/src/bus/queue.ts`
- 修改：`packages/channels/src/core/manager.ts`
- 修改：`packages/channels/src/core/durable-bridge.ts`
- 修改：`packages/channels/src/index.ts`
- 测试：`packages/channels/src/bus/queue.test.ts`
- 测试：`packages/channels/src/__test__/manager.test.ts`
- 测试：`packages/channels/src/__test__/durable-bridge.test.ts`

- [ ] **步骤 1：编写失败的附件传输测试**

```ts
it("preserves inbound attachments through manager and durable metadata", async () => {
  const attachment: ChannelAttachment = {
    type: "image",
    mimeType: "image/png",
    name: "diagram.png",
    externalId: "img_v2_001",
    metadata: { width: 640, height: 480 },
  };

  fake.emit({ chatId: "chat-1", attachments: [attachment], messageType: "image" });
  const inbound = await bus.consumeInbound();

  expect(inbound.attachments).toEqual([attachment]);
  expect(inbound.metadata.attachments).toEqual([attachment]);
});
```

在 outbound 测试中发布：

```ts
bus.publishOutbound({
  channel: "feishu",
  chatId: "chat-1",
  content: "",
  messageType: "image",
  attachments: [attachment],
});
await tick();
expect(fake.sent[0]).toMatchObject({
  messageType: "image",
  attachments: [attachment],
  chatId: "chat-1",
});
```

补充 capability gate 测试：声明只支持 `text` 的 adapter 收到 `messageType: "image"` 时，不得调用 `adapter.send()`，并为 durable delivery 回写 `failed` 及明确错误；声明未包含 `threaded-conversation` 的 adapter 收到带 `threadId` 的消息时同样拒绝。

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/channels test -- --run src/bus/queue.test.ts src/__test__/manager.test.ts src/__test__/durable-bridge.test.ts`
预期：FAIL，原因是 `InboundMessage`、`OutboundMessage` 和 manager 当前没有附件字段。

- [ ] **步骤 3：实现最小传输字段**

为 `InboundMessage` 和 `OutboundMessage` 增加：

```ts
attachments?: ChannelAttachment[];
messageType?: "text" | "image" | "file" | "card" | "event" | "unknown";
threadId?: string;
platformMeta?: Record<string, unknown>;
```

manager 入站映射必须直接复制 `msg.attachments`、`msg.messageType`，并将附件数组写入 metadata；出站构造必须把 bus 中的附件、messageType、threadId 和 platformMeta 原样传给 adapter。Durable bridge 将入站附件描述合并到既有 metadata，不改变 protocol 类型。

在 `ChannelManager.dispatchOutbound()` 中新增严格能力检查：当 adapter 声明了 `capabilities` 时，`text`、`image`、`file`、`threaded-conversation` 分别必须在 `supports` 中；不支持时在调用 adapter 前回写 `failed`，并记录包含 channel、messageType 和 capability 的 warning。未声明 capabilities 的 adapter 不获得隐式能力，仍由 adapter 自己对不支持的消息返回明确错误。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/channels test -- --run src/bus/queue.test.ts src/__test__/manager.test.ts src/__test__/durable-bridge.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add packages/channels/src/index.ts packages/channels/src/bus/queue.ts packages/channels/src/core/manager.ts packages/channels/src/core/durable-bridge.ts packages/channels/src/bus/queue.test.ts packages/channels/src/__test__/manager.test.ts packages/channels/src/__test__/durable-bridge.test.ts
git commit -m "feat(channels): carry attachment metadata through runtime"
```

---

## 任务 2：Feishu 入站 image/file 映射

**文件：**
- 修改：`packages/channels/src/impl/feishu.ts`
- 测试：`packages/channels/src/impl/__test__/feishu.test.ts`

- [ ] **步骤 1：编写失败测试**

覆盖以下真实事件形状：

```ts
const imageEvent = {
  message: {
    message_id: "msg_image",
    chat_id: "oc_chat_001",
    chat_type: "group",
    msg_type: "image",
    content: JSON.stringify({ image_key: "img_v2_001" }),
    create_time: "1710000000000",
    sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
    mentions: [],
  },
};
```

断言：`messageType === "image"`、`content === ""`、附件的 `type === "image"` 且 `externalId === "img_v2_001"`。

文件事件使用 `msg_type: "file"` 和 `{ file_key: "file_v2_001", file_name: "report.pdf" }`，断言 `messageType === "file"`、附件类型、文件名和 externalId 全部保留。

补充失败测试：缺少 `image_key` / `file_key`、未知 `msg_type`、非法 attachment content JSON 时不得调用 handler。

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/channels test -- --run src/impl/__test__/feishu.test.ts`
预期：FAIL，当前 adapter 只读取 `{ text }` 并固定生成 `messageType: "text"`。

- [ ] **步骤 3：实现严格入站解析**

将 Feishu event 类型补充 `msg_type`，按消息类型分支：

```ts
if (msg.msg_type === "text") {
  // 只接受 JSON 中的 string text
} else if (msg.msg_type === "image") {
  // 只接受 string image_key，生成一个 image attachment
} else if (msg.msg_type === "file") {
  // 只接受 string file_key，可选保留 string file_name
} else {
  return;
}
```

图片和文件消息仍必须通过现有 message_id、sender、chat_id、时间戳、thread 目标校验；不再把非文本事件强行当作文本事件。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/channels test -- --run src/impl/__test__/feishu.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add packages/channels/src/impl/feishu.ts packages/channels/src/impl/__test__/feishu.test.ts
git commit -m "feat(feishu): map image and file inbound messages"
```

---

## 任务 3：Feishu 出站 image/file payload

**文件：**
- 修改：`packages/channels/src/impl/feishu.ts`
- 测试：`packages/channels/src/impl/__test__/feishu.test.ts`

- [ ] **步骤 1：编写失败测试**

扩展测试客户端的 `message.create` 调用断言，直接验证平台 payload：

```ts
interface CreateCall {
  params: { receive_id_type: string };
  data: { receive_id: string; content: string; msg_type: string };
}
```

覆盖以下行为：

- 带 `externalId` 的 image 直接使用该 key 发送。
- 带 `externalId` 的 file 直接使用该 key 发送。
- image payload 的 `msg_type` 为 `"image"`，content JSON 精确为 `{ image_key: "..." }`。
- file payload 的 `msg_type` 为 `"file"`，content JSON 精确为 `{ file_key: "..." }`。
- 只有 `data` / `url` 的 image/file、附件为空、附件类型不匹配时明确 reject，且不发送 text 请求。

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/channels test -- --run src/impl/__test__/feishu.test.ts`
预期：FAIL，当前 `send()` 固定调用 `msg_type: "text"`，没有 media upload 或 attachment 分支。

- [ ] **步骤 3：实现严格出站分派**

`send()` 先验证明确的 `replyTo/chatId`、message type 和 attachment externalId：

```ts
switch (message.messageType ?? "text") {
  case "text":
    // 仅发送 content，不允许带附件
    break;
  case "image":
    // 仅接受一个 image attachment，且必须有 Feishu image_key
    break;
  case "file":
    // 仅接受一个 file attachment，且必须有 Feishu file_key
    break;
  default:
    throw new Error("Feishu does not support this outbound message type");
}
```

生产实现扩展现有 `LarkClient.im.message.create` 的 data 联合类型，按 `msg_type` 发送 Feishu media key；不新增 upload wrapper，不 fetch URL，不把 text JSON 伪装成 image/file。`data` 或 `url` 只有在后续独立的 media upload 计划中才允许支持。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/channels test -- --run src/impl/__test__/feishu.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add packages/channels/src/impl/feishu.ts packages/channels/src/impl/__test__/feishu.test.ts
git commit -m "feat(feishu): send image and file attachments"
```

---

## 任务 4：thread/topic 入站与出站路由

**文件：**
- 修改：`packages/channels/src/impl/feishu.ts`
- 修改：`packages/channels/src/core/manager.ts`
- 测试：`packages/channels/src/impl/__test__/feishu.test.ts`
- 测试：`packages/channels/src/__test__/manager.test.ts`
- 测试：`packages/channels/src/__test__/durable-bridge.test.ts`

- [ ] **步骤 1：编写失败测试**

入站事件同时提供 `root_id: "msg_root"` 和 `thread_id: "thread_1"`，断言统一消息使用稳定的 thread 标识，并在 manager/bus/durable metadata 中保持同一个值。

字段语义固定为：`ChannelMessage.threadId` 保存 Feishu `thread_id`；`platformMeta.rootMessageId` 保存 Feishu `root_id`。只有 `rootMessageId` 存在时才允许调用 Feishu thread reply API，不能用 `threadId` 冒充 root message id。

出站测试提供：

```ts
{
  channel: "feishu",
  chatId: "oc_chat_001",
  replyTo: "oc_chat_001",
  threadId: "thread_1",
  platformMeta: { rootMessageId: "msg_root" },
  messageType: "text",
  content: "thread reply",
}
```

断言 Feishu client 使用 thread reply API 或等价的 root 参数 `msg_root`，不发送到普通 chat API。缺少 `platformMeta.rootMessageId` 时，普通消息仍走 chat API；如果消息声明了 `threadId` 但缺少 root message id，则明确失败。

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/channels test -- --run src/impl/__test__/feishu.test.ts src/__test__/manager.test.ts src/__test__/durable-bridge.test.ts`
预期：FAIL，当前 manager 的 outbound contract 没有传递 threadId，Feishu send 也没有 thread 分支。

- [ ] **步骤 3：实现 thread 透传和 Feishu 路由**

manager 出站构造原样传递 `threadId` 和 `platformMeta`；Feishu 入站分别保存 `thread_id` 和 `root_id`，出站只使用 `platformMeta.rootMessageId` 调用明确的 thread/reply API。不得把 threadId 静默丢弃、改写成 chatId 或冒充 root message id。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/channels test -- --run src/impl/__test__/feishu.test.ts src/__test__/manager.test.ts src/__test__/durable-bridge.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add packages/channels/src/impl/feishu.ts packages/channels/src/core/manager.ts packages/channels/src/bus/queue.ts packages/channels/src/impl/__test__/feishu.test.ts packages/channels/src/__test__/manager.test.ts packages/channels/src/__test__/durable-bridge.test.ts
 git commit -m "feat(channels): preserve Feishu thread routing"
```

---

## 任务 5：mention/bot 边界和 capability release gate

**文件：**
- 修改：`packages/channels/src/impl/feishu.ts`
- 修改：`packages/channels/src/index.ts`
- 测试：`packages/channels/src/impl/__test__/feishu.test.ts`
- 测试：`packages/channels/src/__test__/index.test.ts`

- [ ] **步骤 1：编写失败测试**

覆盖：

- 配置 `replyAtBotNames: ["Harness"]` 时，群聊没有匹配 mention 不触发 handler。
- mention name 大小写不同仍按已定义的大小写不敏感规则匹配。
- mention 的 key 被移除后，空文本事件不触发 handler。
- bot sender 永远不触发 handler，即使它带 image/file/thread 字段。
- Feishu capability 明确包含已实现的 `image`、`file`、`threaded-conversation`、`mentions`、`bot-skip-filter`，并且 `supportsImages/supportsFiles` 与实现一致。

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/channels test -- --run src/impl/__test__/feishu.test.ts src/__test__/index.test.ts`
预期：新增的 capability 断言失败，具体表现为 `supports` 不包含 `image` / `file`，或 `supportsImages/supportsFiles` 仍为 `false`；mention/bot 边界测试必须分别指出当前缺口。

- [ ] **步骤 3：实现最终能力声明和过滤规则**

只在 adapter 已具备对应收发分支后，把 image/file 加入 `capabilities.supports` 并将对应布尔字段设置为 `true`；`threaded-conversation`、`mentions`、`bot-skip-filter` 保持声明。过滤逻辑统一在 Feishu adapter 内执行，manager 不解析平台 mention。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/channels test -- --run src/impl/__test__/feishu.test.ts src/__test__/index.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add packages/channels/src/index.ts packages/channels/src/impl/feishu.ts packages/channels/src/impl/__test__/feishu.test.ts packages/channels/src/__test__/index.test.ts
git commit -m "feat(feishu): finalize media and mention capabilities"
```

---

## 任务 6：阶段二完整验证

**文件：**
- 修改：无（仅验证和文档核对）
- 测试：`packages/channels` 全部测试
- 验证：channels 类型、全仓构建、文档路径扫描

- [ ] **步骤 1：运行 channels 全量测试**

运行：`pnpm --filter @openharness/channels test -- --run`
预期：所有测试文件通过，测试数量以 Vitest 实际输出为准。

- [ ] **步骤 2：运行 channels 类型检查**

运行：`pnpm --filter @openharness/channels check-types`
预期：退出码 0。

- [ ] **步骤 3：运行全仓构建**

运行：`pnpm exec turbo build --output-logs=full`
预期：所有任务成功；若 `pnpm build` 使用备用终端缓冲区，使用该命令获取完整结果。

- [ ] **步骤 4：检查严格契约残留**

运行：`rg -n "fallback|fall back|Date\.now\(\)|msg\.message_id \?\?|senderId .*chat_id|image.*text|file.*text|thread.*chat" packages/channels/src/core packages/channels/src/impl/feishu.ts`
预期：不存在把 image/file/thread 缺失字段伪造成 text/chat/随机 ID 的生产实现；合法的 text message 分支不应被该扫描误报。

- [ ] **步骤 5：检查 diff 和工作区**

运行：`git diff --check`、`git status --short`
预期：无格式错误；只剩明确属于本阶段的修改。

---

## 阶段二完成标准

- Feishu image/file 入站事件映射为统一 `ChannelAttachment`，缺少平台 key 时拒绝。
- Feishu image/file 出站只使用真实 media key，不伪装成 text；本阶段不支持 data/url 上传。
- `threadId` 与 `platformMeta.rootMessageId` 从 Feishu 入站到 bus、manager、durable metadata 和出站发送保持各自语义一致。
- mention 过滤、bot skip、空 mention 文本行为均有边界测试。
- Feishu capability 声明与实际实现一致。
- channels 运行时不新增任何兼容性 fallback。
- 本阶段不承诺 durable Agent 生成并发送新的附件；该能力必须另立 protocol/media upload 计划。
- channels 全量测试、类型检查和全仓构建通过。
