import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SessionStore } from "../session-runtime/store.js";

describe("ChannelRepository", () => {
  it("upserts conversations and keeps delivery retries idempotent", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-channel-repository-"));
    const path = join(directory, "sessions.db");
    const store = new SessionStore({ path });
    try {
      store.sessions.create({ id: "session-1", cwd: directory, model: "m" });
      const input = store.conversationTransactions.admitPrompt({ id: "input-1", sessionId: "session-1", content: "hello" });
      const run = store.runs.createRun({ id: "run-1", sessionId: "session-1", inputId: input.id });
      const conversation = store.channels.upsertConversation({
        id: "conversation-1", connector: "feishu", accountId: "account-1",
        workspaceId: "workspace-1", chatId: "chat-1", threadId: "thread-1", sessionId: "session-1",
      });
      const updated = store.channels.upsertConversation({
        connector: "feishu", accountId: "account-1", workspaceId: "workspace-2",
        chatId: "chat-1", threadId: "thread-1", sessionId: "session-1",
      });
      expect(updated).toMatchObject({ id: conversation.id, workspaceId: "workspace-2" });

      const delivery = store.channels.createDelivery({
        id: "delivery-1", conversationId: conversation.id, connector: "feishu",
        accountId: "account-1", chatId: "chat-1", threadId: "thread-1",
        sessionId: "session-1", inputId: input.id, runId: run.id,
        externalMessageId: "external-1", content: "reply",
      });
      expect(store.channels.createDelivery({
        conversationId: conversation.id, connector: "feishu", accountId: "account-1",
        chatId: "chat-1", sessionId: "session-1", inputId: input.id,
        runId: run.id, externalMessageId: "external-retry", content: "reply",
      }).id).toBe(delivery.id);
      expect(() => store.channels.createDelivery({
        conversationId: conversation.id, connector: "feishu", accountId: "account-1",
        chatId: "chat-1", sessionId: "session-1", inputId: input.id,
        runId: run.id, externalMessageId: "external-conflict", content: "different",
      })).toThrow("Channel delivery input is already used");

      expect(store.channels.updateDelivery(delivery.id, { status: "unknown", error: "timeout" }))
        .toMatchObject({ status: "unknown", attemptCount: 1, error: "timeout" });
      const sent = store.channels.updateDelivery(delivery.id, { status: "sent", externalDeliveryId: "sent-1" });
      expect(sent).toMatchObject({ status: "sent", attemptCount: 1, externalDeliveryId: "sent-1" });
      expect(sent.sentAt).toEqual(expect.any(Number));
      expect(store.channels.listConversations({ connector: "feishu", limit: 1 })).toHaveLength(1);
      expect(store.channels.listDeliveries({ statuses: ["sent"], connector: "feishu", limit: 1 })).toHaveLength(1);

      sent.content = "caller mutation";
      expect(store.channels.getDelivery(delivery.id)?.content).toBe("reply");
      expect(store.channels.findDeliveryByInput(input.id)?.id).toBe(delivery.id);
      expect(store.channels.listConversations()).toHaveLength(1);
      expect(store.channels.listDeliveries()).toHaveLength(1);
    } finally {
      store.close();
    }

    const reopened = new SessionStore({ path });
    try {
      expect(reopened.channels.findConversation({ connector: "feishu", accountId: "account-1", chatId: "chat-1", threadId: "thread-1" }))
        .toMatchObject({ id: "conversation-1", workspaceId: "workspace-2" });
      expect(reopened.channels.getDelivery("delivery-1")?.status).toBe("sent");
    } finally {
      reopened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects writes after the application owner changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "ohs-channel-owner-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      store.sessions.create({ id: "session-1", cwd: directory, model: "m" });
      store.acquireApplicationOwner({ ownerId: "owner-a", pid: 1, staleAfterMs: 1_000, now: 10 });
      (store as any).storage.database.connection.prepare("UPDATE application_owner SET owner_id = 'owner-b' WHERE key = 'application'").run();
      expect(() => store.channels.upsertConversation({ connector: "x", accountId: "a", chatId: "c", sessionId: "session-1" })).toThrow();
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
