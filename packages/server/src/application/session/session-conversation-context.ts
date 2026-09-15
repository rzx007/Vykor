import type { SessionStore } from "@openharness/services";
import type { SessionInputConversationCatalog } from "./session-input-materializer.js";

const MAX_CONVERSATION_CONTEXT_CHARS = 12_000;

export function conversationContextCatalog(
  store: Pick<SessionStore, "getSession" | "listMessageParts" | "listMessages">,
  currentSessionId: string,
): SessionInputConversationCatalog {
  return {
    resolveConversation(id) {
      if (id === currentSessionId) return undefined;
      const session = store.getSession(id);
      if (!session || session.status === "archived") return undefined;
      const partsByMessage = new Map<string, string[]>();
      for (const part of store.listMessageParts(id)) {
        if (part.type !== "text" || !part.text) continue;
        const texts = partsByMessage.get(part.messageId) ?? [];
        texts.push(part.text);
        partsByMessage.set(part.messageId, texts);
      }
      const summary = store.listMessages(id)
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => `${message.role === "user" ? "用户" : "助手"}：${(partsByMessage.get(message.id) ?? []).join("")}`)
        .filter((line) => line.trim())
        .join("\n")
        .slice(-MAX_CONVERSATION_CONTEXT_CHARS);
      return { id, title: session.title.trim() || "未命名对话", summary };
    },
  };
}
