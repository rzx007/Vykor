import type { ChannelAdapter, ChannelAdapterCapabilities, ChannelMessage } from "../index";

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  replyAtBotNames?: string[];
}

interface LarkClient {
  im: {
    message: {
      create(params: {
        params: { receive_id_type: string };
        data: {
          receive_id: string;
          content: string;
          msg_type: string;
        };
      }): Promise<void>;
    };
  };
}

interface LarkWSClient {
  start(opts: { eventDispatcher: unknown }): Promise<void>;
  close(): Promise<void>;
}

interface FeishuMention {
  key?: string;
  name?: string;
}

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
    supportsStreaming: false,
    supportsFiles: false,
    supportsImages: false,
    supportsRichCards: false,
    requiresMentionForGroupReply: false,
  };

  private client: LarkClient | null = null;
  private wsClient: LarkWSClient | null = null;
  private handler: ((message: ChannelMessage) => void) | undefined;
  private readonly replyAtBotNames: string[];
  constructor(private readonly config: FeishuConfig) {
    // 统一转小写，使 @mention 匹配大小写不敏感。
    this.replyAtBotNames = (config.replyAtBotNames ?? []).map((n) => n.toLowerCase());
  }

  async connect(): Promise<void> {
    const lark = await import("@larksuiteoapi/node-sdk");

    this.client = new lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      disableTokenCache: false,
    }) as unknown as LarkClient;

    const eventDispatcher = new lark.EventDispatcher({
      encryptKey: this.config.encryptKey ?? "",
      verificationToken: this.config.verificationToken ?? "",
    }).register({
      "im.message.receive_v1": (data: unknown) => this._handleEvent(data),
    });

    this.wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.info,
    }) as unknown as LarkWSClient;

    await this.wsClient.start({ eventDispatcher });
  }

  /** 处理 im.message.receive_v1 事件。提取为方法便于单元测试直接调用。 */
  async _handleEvent(data: unknown): Promise<void> {
    const msg = (data as { message?: {
      message_id?: string;
      root_id?: string;
      thread_id?: string;
      chat_id?: string;
      chat_type?: string;
      content?: string;
      create_time?: string;
      sender?: { sender_id?: { open_id?: string; user_id?: string }; sender_type?: string };
      mentions?: FeishuMention[];
    } })?.message;
    if (!msg?.chat_id || !msg.message_id || !msg.content || !msg.create_time) return;

    // bot 消息跳过：飞书在某些配置下会把 bot 自己发的消息也推回来，直接忽略。
    if (msg.sender?.sender_type === "bot") return;

    let text: unknown;
    try {
      const content = JSON.parse(msg.content) as { text?: unknown };
      text = content.text;
    } catch {
      return;
    }
    if (typeof text !== "string" || !text) return;

    const isGroupChat = msg.chat_type === "group";
    const mentions = msg.mentions ?? [];
    const isAtBot =
      this.replyAtBotNames.length > 0
        ? mentions.some((m) => m.name && this.replyAtBotNames.includes(m.name.toLowerCase()))
        : true;

    if (!isAtBot && isGroupChat) return;

    let contentText = text;
    for (const m of mentions) {
      if (m.key) contentText = contentText.replace(m.key, "").trim();
    }
    contentText = contentText.replace(/\s+/g, " ").trim();
    if (!contentText) return;

    const senderOpenId = msg.sender?.sender_id?.open_id;
    const senderId = senderOpenId ?? msg.sender?.sender_id?.user_id;
    if (!senderId) return;

    // Reply target: group chats → chat_id，direct chats → sender open_id。
    const replyTo = isGroupChat ? msg.chat_id : senderOpenId;
    if (!replyTo) return;

    const timestampMs = Number(msg.create_time);
    if (!Number.isFinite(timestampMs)) return;

    const threadId = msg.thread_id ?? msg.root_id;
    const senderType =
      msg.sender?.sender_type === "bot"
        ? "bot"
        : msg.sender?.sender_type === "user"
          ? "user"
          : "unknown";

    const inbound: ChannelMessage = {
      id: msg.message_id,
      channel: "feishu",
      sender: senderId,
      content: contentText,
      timestamp: new Date(timestampMs),
      conversationId: msg.chat_id,
      chatId: msg.chat_id,
      replyTo,
      threadId,
      senderType,
      messageType: "text",
      metadata: {
        ...(threadId ? { threadId } : {}),
        ...(msg.chat_id ? { chatId: msg.chat_id } : {}),
        ...(msg.chat_type ? { chatType: msg.chat_type } : {}),
      },
      platformMeta: {
        ...(msg.chat_type ? { chatType: msg.chat_type } : {}),
        ...(threadId ? { threadId } : {}),
      },
    };

    if (this.handler) this.handler(inbound);
  }

  async disconnect(): Promise<void> {
    if (this.wsClient) {
      try {
        await this.wsClient.close();
      } catch {
        // ignore
      }
      this.wsClient = null;
    }
    this.client = null;
  }

  async send(message: ChannelMessage): Promise<void> {
    if (!this.client) {
      throw new Error("Feishu client not connected");
    }
    const receiveId = message.replyTo ?? message.chatId;
    if (!receiveId) {
      throw new Error("Feishu outbound message requires replyTo or chatId");
    }
    // Mirror the Python channel's heuristic: chat ids start with "oc_" and use
    // the "chat_id" id-type; everything else is an open_id.
    const receiveIdType = receiveId.startsWith("oc_") ? "chat_id" : "open_id";
    await this.client.im.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: receiveId,
        content: JSON.stringify({ text: message.content }),
        msg_type: "text",
      },
    });
  }

  onMessage(handler: (message: ChannelMessage) => void): void {
    this.handler = handler;
  }
}
