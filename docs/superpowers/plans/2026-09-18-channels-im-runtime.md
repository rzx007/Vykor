# 通道 IM Runtime 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 channels 从 Feishu 适配器骨架升级为严格的 IM runtime 统一契约，删除所有 legacy/fallback 语义，只保留设计中约定的 message、adapter capability、conversation 和 delivery 语义。

**架构：** 计划分为四个独立可审查的任务：先收口通用消息与能力接口，再收紧 ChannelManager 路由与 delivery，再实现 Feishu 的严格适配，最后统一执行验证。所有兼容性分支都视为不符合当前设计，必须在实现前明确删除。

**技术栈：** TypeScript、Vitest、pnpm workspace、Feishu SDK、MessageBus、ChannelManager

---

## 任务 1：收口统一消息契约

**文件：**
- 创建：无
- 修改：`packages/channels/src/index.ts`
- 测试：`packages/channels/src/__test__/index.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, it, expect } from "vitest";
import type { ChannelMessage, ChannelAdapterCapabilities } from "../index.js";

describe("channel message contract", () => {
  it("declares the strict message fields required by the IM runtime", () => {
    const message: ChannelMessage = {
      id: "msg_001",
      channel: "feishu",
      sender: "ou_user",
      content: "hello",
      timestamp: new Date(0),
      conversationId: "chat_001",
      chatId: "chat_001",
      replyTo: "chat_001",
      threadId: "thread_001",
      senderType: "user",
      messageType: "text",
      workspaceId: "ws_001",
      metadata: { chatType: "group" },
      platformMeta: { chatType: "group" },
    };

    expect(message.conversationId).toBe("chat_001");
    expect(message.chatId).toBe("chat_001");
    expect(message.replyTo).toBe("chat_001");
    expect(message.messageType).toBe("text");
  });

  it("exposes adapter capability metadata", () => {
    const capabilities: ChannelAdapterCapabilities = {
      supports: ["text", "group-chat", "private-chat", "delivery-status"],
      supportsFiles: false,
      supportsImages: false,
    };

    expect(capabilities.supports).toContain("text");
    expect(capabilities.supports).toContain("delivery-status");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/channels test -- --run src/__test__/index.test.ts`
预期：FAIL，报错为 `ChannelMessage` 缺少 `conversationId` / `chatId` / `replyTo` 等字段，或者 `ChannelAdapterCapabilities` 未定义。

- [ ] **步骤 3：编写最少实现代码**

```ts
export type ChannelCapability =
  | "text"
  | "image"
  | "file"
  | "rich-card"
  | "stream"
  | "mentions"
  | "threaded-conversation"
  | "group-chat"
  | "private-chat"
  | "delivery-status"
  | "acknowledgement"
  | "bot-skip-filter";

export interface ChannelAdapterCapabilities {
  supports: ChannelCapability[];
  maxTextLength?: number;
  supportsStreaming?: boolean;
  supportsFiles?: boolean;
  supportsImages?: boolean;
  supportsRichCards?: boolean;
  requiresMentionForGroupReply?: boolean;
}

export interface ChannelMessage {
  id: string;
  channel: string;
  sender: string;
  content: string;
  timestamp: Date;
  conversationId?: string;
  chatId?: string;
  replyTo?: string;
  threadId?: string;
  externalMessageId?: string;
  senderType?: "user" | "bot" | "system" | "unknown";
  messageType?: "text" | "image" | "file" | "card" | "event" | "unknown";
  attachments?: ChannelAttachment[];
  workspaceId?: string;
  metadata?: Record<string, unknown>;
  platformMeta?: Record<string, unknown>;
}

export interface ChannelAdapter {
  name: string;
  capabilities?: ChannelAdapterCapabilities;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: ChannelMessage): Promise<void>;
  onMessage(handler: (message: ChannelMessage) => void): void;
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/channels test -- --run src/__test__/index.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add packages/channels/src/index.ts packages/channels/src/__test__/index.test.ts
git commit -m "feat(channels): add strict message capability contract"
```

---

## 任务 2：收紧 ChannelManager 路由与 delivery

**文件：**
- 修改：`packages/channels/src/core/manager.ts`
- 测试：`packages/channels/src/__test__/manager.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, it, expect } from "vitest";
import { MessageBus } from "../bus/queue.js";
import { ChannelManager } from "../core/manager.js";
import type { ChannelAdapter, ChannelMessage } from "../index.js";

function makeAdapter(name: string): ChannelAdapter {
  let handler: ((m: ChannelMessage) => void) | undefined;
  return {
    name,
    async connect() {},
    async disconnect() {},
    async send(message) {
      if (handler) handler(message);
    },
    onMessage(next) {
      handler = next;
    },
  };
}

describe("ChannelManager strict contract", () => {
  it("routes inbound messages by explicit chatId without sender fallback semantics", async () => {
    const bus = new MessageBus();
    const adapter = makeAdapter("feishu");
    const manager = new ChannelManager([adapter], bus, {
      allowFrom: { feishu: ["ou_user"] },
    });

    await manager.startAll();
    adapter.onMessage?.({
      id: "msg_1",
      channel: "feishu",
      sender: "ou_user",
      content: "hello",
      timestamp: new Date(0),
      conversationId: "chat_1",
      chatId: "chat_1",
      replyTo: "chat_1",
      senderType: "user",
      messageType: "text",
    });

    const msg = await bus.consumeInbound();
    expect(msg.chatId).toBe("chat_1");
    expect(msg.senderId).toBe("ou_user");
    await manager.stopAll();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/channels test -- --run src/__test__/manager.test.ts`
预期：FAIL，表示 `handleInbound` 仍未要求明确 `chatId`，或仍依赖 `msg.replyTo` / `msg.sender` 猜测会话目标。

- [ ] **步骤 3：编写最少实现代码**

```ts
private handleInbound(channelName: string, msg: ChannelMessage): void {
  const allowList = this.opts.allowFrom[channelName];
  if (!isAllowed(msg.sender, allowList)) {
    this.opts.onWarning?.(`通道 ${channelName} 拒绝来自 ${msg.sender} 的消息（不在 allowFrom）。`);
    return;
  }

  const inbound: InboundMessage = {
    channel: channelName,
    accountId: this.opts.accountIds?.[channelName] ?? "default",
    externalMessageId: msg.id,
    senderId: msg.sender,
    chatId: msg.chatId,
    content: msg.content,
    timestamp: msg.timestamp,
    media: [],
    metadata: {
      _message_id: msg.id,
      ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
      ...(msg.threadId ? { threadId: msg.threadId } : {}),
    },
    ...(msg.workspaceId ? { workspaceId: msg.workspaceId } : {}),
    ...(msg.threadId ? { threadId: msg.threadId } : {}),
  };

  this.bus.publishInbound(inbound);
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/channels test -- --run src/__test__/manager.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add packages/channels/src/core/manager.ts packages/channels/src/__test__/manager.test.ts
git commit -m "feat(channels): enforce strict manager routing semantics"
```

---

## 任务 3：Feishu 适配器实现严格能力与消息映射

**文件：**
- 修改：`packages/channels/src/impl/feishu.ts`
- 测试：`packages/channels/src/impl/__test__/feishu.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { describe, it, expect } from "vitest";
import { FeishuAdapter } from "../feishu.js";

describe("FeishuAdapter strict contract", () => {
  it("declares the supported capabilities for the first Feishu slice", () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    expect(adapter.capabilities).toMatchObject({
      supports: expect.arrayContaining(["text", "group-chat", "private-chat", "delivery-status"]),
    });
  });

  it("emits conversationId and chatId from the Feishu event payload", async () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    const received: Array<{ conversationId?: string; chatId?: string; senderType?: string; messageType?: string }> = [];

    adapter.onMessage((message) => {
      received.push({
        conversationId: message.conversationId,
        chatId: message.chatId,
        senderType: message.senderType,
        messageType: message.messageType,
      });
    });

    await (adapter as any)._handleEvent({
      message: {
        message_id: "msg_ctx",
        chat_id: "oc_chat_001",
        chat_type: "group",
        content: JSON.stringify({ text: "hello" }),
        create_time: String(Date.now()),
        sender: {
          sender_id: { open_id: "ou_sender", user_id: "u1" },
          sender_type: "user",
        },
        mentions: [],
      },
    });

    expect(received[0]).toMatchObject({
      conversationId: "oc_chat_001",
      chatId: "oc_chat_001",
      senderType: "user",
      messageType: "text",
    });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/channels test -- --run src/impl/__test__/feishu.test.ts`
预期：FAIL，说明当前 `FeishuAdapter` 尚未提供 `capabilities` 和 conversation 结构化映射。

- [ ] **步骤 3：编写最少实现代码**

```ts
export class FeishuAdapter implements ChannelAdapter {
  name = "feishu";
  readonly capabilities: ChannelAdapterCapabilities = {
    supports: [
      "text",
      "mentions",
      "threaded-conversation",
      "group-chat",
      "private-chat",
      "delivery-status",
      "bot-skip-filter",
    ],
    maxTextLength: 2000,
    supportsFiles: false,
    supportsImages: false,
    supportsRichCards: false,
    requiresMentionForGroupReply: false,
  };

  async _handleEvent(data: unknown): Promise<void> {
    const msg = (data as any)?.message;
    if (!msg?.chat_id) return;
    if (msg.sender?.sender_type === "bot") return;

    const text = this.parseText(msg.content);
    if (!text) return;

    const senderOpenId = msg.sender?.sender_id?.open_id;
    const senderId = senderOpenId ?? msg.sender?.sender_id?.user_id;
    const threadId = msg.thread_id ?? msg.root_id;
    const isGroupChat = msg.chat_type === "group";
    const replyTo = isGroupChat ? msg.chat_id : senderOpenId;

    const inbound: ChannelMessage = {
      id: msg.message_id,
      channel: "feishu",
      sender: senderId,
      content: text,
      timestamp: new Date(Number(msg.create_time)),
      conversationId: msg.chat_id,
      chatId: msg.chat_id,
      replyTo,
      threadId,
      senderType: msg.sender?.sender_type === "user" ? "user" : "unknown",
      messageType: "text",
      metadata: {
        chatType: msg.chat_type,
        ...(threadId ? { threadId } : {}),
      },
      platformMeta: {
        chatType: msg.chat_type,
        ...(threadId ? { threadId } : {}),
      },
    };

    this.handler?.(inbound);
  }

  async send(message: ChannelMessage): Promise<void> {
    const receiveId = message.replyTo ?? message.chatId;
    const receiveIdType = receiveId.startsWith("oc_") ? "chat_id" : "open_id";

    await this.client!.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        content: JSON.stringify({ text: message.content }),
        msg_type: "text",
      },
    });
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/channels test -- --run src/impl/__test__/feishu.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add packages/channels/src/impl/feishu.ts packages/channels/src/impl/__test__/feishu.test.ts
git commit -m "feat(feishu): implement strict runtime mapping and capabilities"
```

---

## 任务 4：统一回归验证与 release gate

**文件：**
- 修改：无（仅验证）
- 测试：`packages/channels` 全目录

- [ ] **步骤 1：执行 full package check**

运行：`pnpm --filter @openharness/channels test -- --run`
预期：5 个测试文件全部通过，测试总数以 Vitest 实际输出为准，退出码 0。

- [ ] **步骤 2：检查误差与兼容残留**

搜索 `legacy`、`fallback`、`compat`、`?? msg.sender`、`chatId ?? msg.sender` 等兼容型模式，确认不出现在 channels 实现中；设计文档只能以“禁止降级”的语义描述这些词。

- [ ] **步骤 3：记录完成条件**

- [ ] 已删除兼容性 fallback 分支
- [ ] 已保留当前设计要求的唯一发送/接收契约
- [ ] `FeishuAdapter` 已具备能力声明
- [ ] `ChannelMessage` 已具备统一 conversation 语义
- [ ] `ChannelManager` 正确执行 ACL + 路由 + delivery
- [ ] package 全量测试通过

---

## 关键禁止项

- 不保留 `replyTo ?? sender` 的回退行为。
- 不在通用层伪造“兼容旧消息格式”的字段。
- 不在 adapter 中把平台细节写回通用层。
- 不把 “旧协议兼容” 当作新功能和重构理由。
- 不扩展到 image / file / stream 的第二阶段实现，除非在本计划完成后另起子计划。

## 任务完成后的状态

当前 channels 层将严格遵循如下约束：

1. `ChannelMessage` 是统一 IM 语义对象，不再依赖历史轻量协议。
2. `ChannelAdapter.capabilities` 为事实能力声明，不存在隐式默认能力集。
3. `ChannelManager` 只处理设计定义的 inbound / outbound 结构。
4. Feishu 仅负责映射其平台事件到该统一协议，并不泄露平台对象到上层。
5. 兼容逻辑的清理会被视为本次工作的一部分，且必须出现在最终 diff 中。
