import { describe, expect, it, vi } from "vitest";
import { ApplicationEventService } from "../../../application/events/application-event-service.js";
import { HttpEventHub } from "../events.js";

describe("HTTP event backpressure", () => {
  it("preserves a history read failure instead of closing the HTTP stream normally", async () => {
    const failure = new Error("replay read failed");
    const events = new ApplicationEventService({ latestEventSeq: () => 1, listEvents: () => { throw failure; } });
    const hub = new HttpEventHub(events);
    try {
      const response = await hub.createRoutes().request("/stream");
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
      await expect(reader.read()).rejects.toBe(failure);
      expect(events.subscriberCount).toBe(0);
      expect(hub.clientCount).toBe(0);
    } finally { hub.closeClients(); events.close(); }
  });

  it.each(["replay read failed", undefined])("reports a non-Error history failure (%s) instead of closing normally", async failure => {
    const events = new ApplicationEventService({ latestEventSeq: () => 1, listEvents: () => { throw failure; } });
    const hub = new HttpEventHub(events);
    try {
      const response = await hub.createRoutes().request("/stream");
      const reader = response.body!.getReader();
      await reader.read();
      await expect(reader.read()).rejects.toMatchObject({ name: "Error", message: "Application event stream failed" });
      expect(events.subscriberCount).toBe(0);
      expect(hub.clientCount).toBe(0);
    } finally { hub.closeClients(); events.close(); }
  });

  it("keeps a single completion handler on an event wait across idle heartbeats", async () => {
    vi.useFakeTimers();
    const events = new ApplicationEventService({ latestEventSeq: () => 0, listEvents: () => [] });
    const subscribe = events.subscribe.bind(events);
    let completionHandlers = 0;
    // Keep the real subscription and cancellation, observing only registrations on its next promise.
    vi.spyOn(events, "subscribe").mockImplementation(options => {
      const subscription = subscribe(options);
      const iterator = subscription.stream[Symbol.asyncIterator]();
      return { ...subscription, stream: { [Symbol.asyncIterator]: () => ({
        next: () => {
          const pending = iterator.next();
          const then = pending.then.bind(pending);
          pending.then = (fulfilled, rejected) => {
            completionHandlers++;
            return then(fulfilled, rejected);
          };
          return pending;
        },
      }) } };
    });
    const hub = new HttpEventHub(events);
    try {
      const response = await hub.createRoutes().request("/stream");
      const reader = response.body!.getReader();
      await reader.read();
      for (let count = 0; count < 100; count++) {
        const heartbeat = reader.read();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(new TextDecoder().decode((await heartbeat).value)).toBe(": keepalive\n\n");
      }
      expect(completionHandlers).toBe(1);
      const waiting = reader.read();
      await reader.cancel();
      expect(await waiting).toEqual({ done: true, value: undefined });
      expect(events.subscriberCount).toBe(0);
      expect(hub.clientCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { hub.closeClients(); events.close(); vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it("sends idle heartbeats only for pending reads and stops timers on cancellation", async () => {
    vi.useFakeTimers();
    const events = new ApplicationEventService({ latestEventSeq: () => 0, listEvents: () => [] });
    const hub = new HttpEventHub(events);
    try {
      const response = await hub.createRoutes().request("/stream");
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(": connected\n\n");
      const heartbeat = reader.read();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(new TextDecoder().decode((await heartbeat).value)).toBe(": keepalive\n\n");
      await vi.advanceTimersByTimeAsync(150_000);
      expect(vi.getTimerCount()).toBe(0);
      const next = reader.read();
      events.broadcastEvent({ id: "e1", seq: 1, schemaVersion: 1, type: "session.updated", payload: {}, createdAt: 1 });
      expect(new TextDecoder().decode((await next).value)).toContain("id: 1\n");
      const waiting = reader.read();
      await reader.cancel();
      await waiting;
      expect(events.subscriberCount).toBe(0);
      expect(hub.clientCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { hub.closeClients(); events.close(); vi.useRealTimers(); }
  });

  it("does not drain application events into an unread HTTP body and errors immediately on overflow", async () => {
    const events = new ApplicationEventService({ latestEventSeq: () => 0, listEvents: () => [] });
    const hub = new HttpEventHub(events);
    const response = await hub.createRoutes().request("/stream");
    for (let seq = 1; seq <= 10000; seq++) {
      events.broadcastEvent({ id: `e${seq}`, seq, schemaVersion: 1, type: "session.updated", payload: {}, createdAt: seq });
      // An eager pump can otherwise move the entire queue into ReadableStream.
      await Promise.resolve();
    }
    expect(events.subscriberCount).toBe(0);
    expect(hub.clientCount).toBe(0);
    await expect(response.body!.getReader().read()).rejects.toMatchObject({ lastConsumedCursor: 0 });
    hub.closeClients();
  });

  it("cancels a body that was never read", async () => {
    const events = new ApplicationEventService({ latestEventSeq: () => 0, listEvents: () => [] });
    const hub = new HttpEventHub(events);
    const response = await hub.createRoutes().request("/stream");
    await response.body!.cancel();
    expect(events.subscriberCount).toBe(0);
    expect(hub.clientCount).toBe(0);
  });

  it("keeps a reading HTTP connection independent of an unread connection", async () => {
    const events = new ApplicationEventService({ latestEventSeq: () => 0, listEvents: () => [] });
    const hub = new HttpEventHub(events);
    const unread = await hub.createRoutes().request("/stream");
    const reading = await hub.createRoutes().request("/stream");
    const reader = reading.body!.getReader();
    await reader.read();
    try {
      for (let seq = 1; seq <= 1000; seq++) {
        const next = reader.read();
        events.broadcastEvent({ id: `e${seq}`, seq, schemaVersion: 1, type: "session.updated", payload: {}, createdAt: seq });
        expect(new TextDecoder().decode((await next).value)).toContain(`id: ${seq}\n`);
      }
      expect(hub.clientCount).toBe(1);
      expect(events.subscriberCount).toBe(1);
      await expect(unread.body!.getReader().read()).rejects.toMatchObject({ lastConsumedCursor: 0 });
    } finally { await reader.cancel(); hub.closeClients(); events.close(); }
  });
});
