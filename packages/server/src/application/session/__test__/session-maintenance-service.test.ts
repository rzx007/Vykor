import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionStore } from "@openharness/services";

import { SessionMaintenanceService } from "../session-maintenance-service.js";
import { DaemonOperationGate } from "../../control/daemon-operation-gate.js";

const session = {
  id: "s1",
  cwd: "/repo",
  title: "Session",
  model: "gpt-test",
  status: "idle",
  metadata: {},
  createdAt: 1,
  updatedAt: 1,
};

function createMaintenance(agent: Record<string, any>, options: { personalizationUpdater?: (messages: any[]) => number } = {}) {
  const replaced = { messages: [{ id: "persisted-message" }], parts: [{ id: "persisted-part" }] };
  let presentationSequence = 0;
  const store = {
    getSession: vi.fn(() => session),
    listMessages: vi.fn(() => []),
    listMessageParts: vi.fn(() => []),
    replaceTranscript: vi.fn(() => replaced),
    createMessage: vi.fn((input) => ({
      ...input,
      id: `presentation-message-${++presentationSequence}`,
      seq: presentationSequence,
      createdAt: presentationSequence,
      updatedAt: presentationSequence,
    })),
    upsertMessagePart: vi.fn((input) => ({
      ...input,
      id: `presentation-part-${presentationSequence}`,
      seq: presentationSequence,
      metadata: {},
      createdAt: presentationSequence,
      updatedAt: presentationSequence,
    })),
  };
  const runEngine = {
    hasWork: vi.fn(() => false),
    hasActiveRunsForCwd: vi.fn(() => false),
  };
  const agentPool = {
    configured: true,
    acquireSession: vi.fn(async () => agent),
    hasActiveWorkForSession: vi.fn(() => false),
    hasActiveWorkForCwd: vi.fn(() => false),
    close: vi.fn(async () => {}),
    closeForCwd: vi.fn(async () => {}),
  };
  const broadcastSince = vi.fn();
  const operationGate = new DaemonOperationGate();
  const maintenance = new SessionMaintenanceService({
    data: {
      sessions: { get: store.getSession },
      conversations: {
        listInputs: vi.fn(() => []),
        listMessages: store.listMessages,
        listMessageParts: store.listMessageParts,
        createMessage: store.createMessage,
        upsertMessagePart: store.upsertMessagePart,
      },
      conversationTransactions: { replaceTranscript: store.replaceTranscript },
    } as any,
    runControl: runEngine as any,
    agentPool: agentPool as any,
    liveChildren: { has: vi.fn(() => false) },
    operationGate,
    events: { checkpoint: () => 7, publishSince: broadcastSince },
    personalizationUpdater: options.personalizationUpdater,
  });
  return { maintenance, store, runEngine, agentPool, operationGate, broadcastSince, replaced };
}

describe("SessionMaintenanceService", () => {
  it("keeps durable prompt attachment references unchanged while compacting the transcript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oh-compact-attachments-"));
    const store = new SessionStore({ path: join(dir, "sessions.db") });
    try {
      store.sessions.create({ id: "s1", cwd: "/repo", model: "gpt-test" });
      store.attachments.createImportingAttachment({ id: "att-1", displayName: "screen.png", stagingName: "att-1.part" });
      store.attachments.markAttachmentReady("att-1", {
        mediaType: "image/png", sizeBytes: 42, sha256: "a".repeat(64),
      });
      const input = store.conversationTransactions.admitPrompt({
        id: "input-1", sessionId: "s1", content: "", attachments: [{ assetId: "att-1", intent: "ocr" }],
      });
      const before = store.conversations.listInputAttachments(input.id);
      const compact = vi.fn(async () => ({
        history: [{ type: "assistant", content: "summary without invented OCR" }],
        beforeMessageCount: 2,
        afterMessageCount: 1,
      }));
      const maintenance = new SessionMaintenanceService({
        data: store,
        runControl: { hasWork: () => false, hasActiveRunsForCwd: () => false } as any,
        agentPool: {
          configured: true,
          acquireSession: async () => ({ compact }),
          hasActiveWorkForSession: () => false,
          hasActiveWorkForCwd: () => false,
        } as any,
        liveChildren: { has: () => false },
        operationGate: new DaemonOperationGate(),
        events: { checkpoint: () => 0, publishSince: () => {} },
      });

      await maintenance.compact("s1");

      expect(store.conversations.listInputAttachments(input.id)).toEqual(before);
      expect(store.conversations.listMessageParts("s1").map((part) => part.text).filter(Boolean)).toEqual([
        "summary without invented OCR",
        "已压缩上下文",
      ]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists the compacted transcript and broadcasts the replacement", async () => {
    const compact = vi.fn(async () => ({ history: [], beforeMessageCount: 3, afterMessageCount: 2 }));
    const { maintenance, store, broadcastSince, replaced } = createMaintenance({ compact });

    const result = await maintenance.compact("s1");

    expect(compact).toHaveBeenCalledOnce();
    expect(store.replaceTranscript).toHaveBeenCalledWith({ sessionId: "s1", messages: [] });
    expect(store.upsertMessagePart.mock.calls.map(([part]) => part.text)).toEqual([
      "正在压缩上下文",
      "已压缩上下文",
    ]);
    expect(result).toEqual({ messageCount: 2, ...replaced });
    expect(broadcastSince).toHaveBeenCalledWith(7);
  });

  it("replaces a rewound transcript and closes its stale runtime", async () => {
    const { maintenance, store, agentPool, broadcastSince } = createMaintenance({});
    store.listMessages.mockReturnValue([{
      id: "message-1",
      seq: 1,
      sessionId: "s1",
      role: "user",
      metadata: {},
    }] as any);
    store.listMessageParts.mockReturnValue([{
      id: "part-1",
      seq: 1,
      sessionId: "s1",
      messageId: "message-1",
      type: "text",
      status: "completed",
      text: "hello",
      metadata: {},
    }] as any);

    const result = await maintenance.rewind("s1", 1);

    expect(result).toMatchObject({ turns: 1, removed: 1 });
    expect(store.replaceTranscript).toHaveBeenCalledWith({ sessionId: "s1", messages: [] });
    expect(agentPool.close).toHaveBeenCalledWith("s1");
    expect(broadcastSince).toHaveBeenCalledWith(7);
  });

  it("extracts memories and closes every runtime for the cwd", async () => {
    const remembered = { skipped: false, writtenIds: ["memory-1"], titles: ["Fact"] };
    const remember = vi.fn(async () => remembered);
    const personalizationUpdater = vi.fn(() => 1);
    const { maintenance, agentPool, store } = createMaintenance({ remember }, { personalizationUpdater });
    store.listMessages.mockReturnValue([{
      id: "m1",
      seq: 1,
      sessionId: "s1",
      role: "user",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }] as any);
    store.listMessageParts.mockReturnValue([{
      id: "p1",
      seq: 1,
      sessionId: "s1",
      messageId: "m1",
      type: "text",
      status: "completed",
      text: "ssh ops@10.0.0.9",
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }] as any);

    await expect(maintenance.remember("s1")).resolves.toBe(remembered);
    expect(personalizationUpdater).toHaveBeenCalledWith([{ role: "user", content: "ssh ops@10.0.0.9" }]);
    expect(agentPool.closeForCwd).toHaveBeenCalledWith("/repo");
  });

  it("does not fail remember when local personalization extraction fails", async () => {
    const remembered = { skipped: false, writtenIds: ["memory-1"], titles: ["Fact"] };
    const remember = vi.fn(async () => remembered);
    const personalizationUpdater = vi.fn(() => {
      throw new Error("disk full");
    });
    const { maintenance, agentPool } = createMaintenance({ remember }, { personalizationUpdater });

    await expect(maintenance.remember("s1")).resolves.toBe(remembered);
    expect(agentPool.closeForCwd).toHaveBeenCalledWith("/repo");
  });

  it("holds a session barrier for the complete asynchronous compact operation", async () => {
    let finish!: () => void;
    const compact = vi.fn(() => new Promise<any>((resolve) => {
      finish = () => resolve({ history: [], beforeMessageCount: 1, afterMessageCount: 0 });
    }));
    const { maintenance, operationGate } = createMaintenance({ compact });

    const running = maintenance.compact("s1");
    await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce());
    expect(() => operationGate.enter({ sessionId: "s1", cwd: "/repo" })).toThrow(/blocked/);

    finish();
    await running;
    expect(() => operationGate.enter({ sessionId: "s1", cwd: "/repo" })).not.toThrow();
  });

  it("propagates required runtime creation failures", async () => {
    const { maintenance, agentPool } = createMaintenance({});
    agentPool.acquireSession.mockRejectedValueOnce(new Error("provider startup failed"));

    await expect(maintenance.listMcpServers("s1")).rejects.toThrow("provider startup failed");
  });
});
