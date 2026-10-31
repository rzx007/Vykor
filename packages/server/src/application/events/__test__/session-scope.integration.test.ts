import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "@vykor/services";
import type { SessionEventRecord } from "@vykor/domain-contracts/sessions";
import { ApplicationEventService } from "../application-event-service.js";

describe("session event scope across durable replay and live delivery", () => {
  it("delivers a parent-tree deletion to parent, child and global subscribers just as replay does", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vykor-event-scope-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    const events = new ApplicationEventService(store.conversations);
    try {
      store.sessions.create({ id: "parent", cwd: directory, model: "fixture" });
      store.sessions.create({ id: "child", parentId: "parent", cwd: directory, model: "fixture" });
      store.sessions.create({ id: "other", cwd: directory, model: "fixture" });
      const before = store.conversations.latestEventSeq();
      const subscriptions = ["parent", "child", "other", undefined].map(sessionId => ({
        sessionId,
        iterator: events.subscribe({ after: before, sessionId }).stream[Symbol.asyncIterator](),
      }));
      expect(store.conversationTransactions.deleteSessionTree("parent")).toEqual(["parent", "child"]);
      events.broadcastSince(before);
      const pending = subscriptions.map(({ iterator }) => iterator.next());
      // Closing wakes a missing live delivery too, so the regression never waits on a timeout.
      events.close();
      const received = await Promise.all(pending);
      for (const [index, subscription] of subscriptions.entries()) {
        const replay = store.conversations.listEvents({ afterSeq: before, sessionId: subscription.sessionId, limit: 128 });
        expect(replay).toHaveLength(1);
        expect(replay[0]).toMatchObject({ type: "session.deleted", payload: { sessionIds: ["parent", "child"] } });
        expect(received[index]).toMatchObject({ done: false, value: replay[0] });
        await subscription.iterator.return?.();
        const recovered = new ApplicationEventService(store.conversations);
        const restored = recovered.subscribe({ after: before, sessionId: subscription.sessionId }).stream[Symbol.asyncIterator]();
        try { expect(await restored.next()).toMatchObject({ done: false, value: replay[0] }); }
        finally { await restored.return?.(); recovered.close(); }
      }
      expect(events.subscriberCount).toBe(0);
    } finally { events.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("matches historical and live global events without leaking another session's private events", async () => {
    const durable: SessionEventRecord[] = [];
    const service = new ApplicationEventService({
      latestEventSeq: () => durable.at(-1)?.seq ?? 0,
      listEvents: ({ afterSeq = 0, sessionId, limit } = {}) => durable
        .filter(event => event.seq > afterSeq && (!sessionId || event.sessionId === undefined || event.sessionId === sessionId))
        .slice(0, limit),
    });
    const live = service.subscribe({ sessionId: "wanted" }).stream[Symbol.asyncIterator]();
    try {
      for (const [index, sessionId] of ["wanted", "foreign", undefined, undefined, "wanted"].entries()) {
        const event: SessionEventRecord = {
          id: `event-${index + 1}`, seq: index + 1, schemaVersion: 1,
          type: index === 3 ? "session.deleted" : "session.updated",
          ...(sessionId ? { sessionId } : {}), payload: {}, createdAt: index,
        };
        durable.push(event); service.broadcastEvent(event);
      }
      const received: SessionEventRecord[] = [];
      for await (const event of { [Symbol.asyncIterator]: () => live }) {
        received.push(event);
        // This session-owned fence arrives with or without the regression,
        // avoiding timing assumptions when checking the preceding global events.
        if (event.seq === 5) break;
      }
      expect(received).toEqual(service.list({ sessionId: "wanted", limit: 128 }));
      expect(received.map(event => event.seq)).toEqual([1, 3, 4, 5]);
    } finally { service.close(); await live.return?.(); }
  });
});
