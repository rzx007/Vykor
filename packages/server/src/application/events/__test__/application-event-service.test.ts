import { describe, expect, it } from "vitest";

import type { SessionEventRecord } from "@vykor/domain-contracts/sessions";

import { ApplicationEventService } from "../application-event-service.js";

function event(seq: number, sessionId = "s1"): SessionEventRecord {
  return {
    id: `event-${seq}`,
    seq,
    schemaVersion: 1,
    type: "session.updated",
    sessionId,
    payload: {},
    createdAt: seq,
  };
}

describe("ApplicationEventService", () => {
  it("preserves a history read failure in both the iterator and termination signal", async () => {
    const failure = new Error("replay read failed");
    const service = new ApplicationEventService({ latestEventSeq: () => 1, listEvents: () => { throw failure; } });
    const subscription = service.subscribe();
    await expect(subscription.stream[Symbol.asyncIterator]().next()).rejects.toBe(failure);
    expect(subscription.signal.aborted).toBe(true);
    expect(subscription.signal.reason).toBe(failure);
    expect(service.subscriberCount).toBe(0);
  });

  it.each(["replay read failed", undefined])("normalizes a non-Error history failure (%s) for the termination signal", async failure => {
    const service = new ApplicationEventService({ latestEventSeq: () => 1, listEvents: () => { throw failure; } });
    const subscription = service.subscribe();
    await expect(subscription.stream[Symbol.asyncIterator]().next()).rejects.toBe(failure);
    expect(subscription.signal.reason).toMatchObject({ name: "Error", message: "Application event stream failed" });
    expect(service.subscriberCount).toBe(0);
  });

  it("removes a subscription when reading its checkpoint fails", () => {
    const service = new ApplicationEventService({ latestEventSeq: () => { throw new Error("store unavailable"); }, listEvents: () => [] });
    expect(() => service.subscribe()).toThrow("store unavailable");
    expect(service.subscriberCount).toBe(0);
  });

  it("closes an unread subscription after 10000 broadcasts and resumes from the consumed cursor", async () => {
    const durable: SessionEventRecord[] = [];
    const service = new ApplicationEventService({
      latestEventSeq: () => durable.at(-1)?.seq ?? 0,
      listEvents: ({ afterSeq = 0, limit } = {}) => durable.filter(item => item.seq > afterSeq).slice(0, limit),
    });
    const slow = service.subscribe();
    const iterator = slow.stream[Symbol.asyncIterator]();
    durable.push(event(1)); service.broadcastEvent(durable[0]!);
    expect((await iterator.next()).value?.seq).toBe(1);
    for (let seq = 2; seq <= 10000; seq++) {
      const record = event(seq); durable.push(record); service.broadcastEvent(record);
    }
    expect(service.subscriberCount).toBe(0);
    expect(slow.signal.aborted).toBe(true);
    expect(slow.signal.reason).toMatchObject({ lastConsumedCursor: 1 });
    await expect(iterator.next()).rejects.toMatchObject({ lastConsumedCursor: 1 });
    const restored = service.subscribe({ after: 1 });
    const received: number[] = [];
    for await (const record of restored.stream) {
      received.push(record.seq);
      if (record.seq === 10000) break;
    }
    expect(received).toEqual(Array.from({ length: 9999 }, (_, index) => index + 2));
  });

  it("pages history only on demand and stops replay at its checkpoint", async () => {
    const durable = Array.from({ length: 1000 }, (_, index) => event(index + 1));
    let reads = 0;
    const service = new ApplicationEventService({
      latestEventSeq: () => durable.at(-1)?.seq ?? 0,
      listEvents: ({ afterSeq = 0, limit } = {}) => {
        if (limit === undefined || limit > 128) throw new Error("unbounded history read");
        reads++;
        return durable.filter(item => item.seq > afterSeq).slice(0, limit);
      },
    });
    const subscription = service.subscribe();
    expect(reads).toBe(0);
    const iterator = subscription.stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.seq).toBe(1);
    expect(reads).toBe(1);
    durable.push(event(1001)); service.broadcastEvent(event(1001));
    for (let seq = 2; seq <= 1001; seq++) expect((await iterator.next()).value?.seq).toBe(seq);
    await iterator.return?.();
    expect(service.subscriberCount).toBe(0);
  });

  it("cleans up cancellation before iteration starts", () => {
    const abort = new AbortController();
    const service = new ApplicationEventService({ latestEventSeq: () => 0, listEvents: () => [] });
    service.subscribe({ signal: abort.signal });
    abort.abort();
    expect(service.subscriberCount).toBe(0);
  });

  it("keeps a normally consumed subscription live when another subscriber overflows", async () => {
    const service = new ApplicationEventService({ latestEventSeq: () => 0, listEvents: () => [] });
    const slow = service.subscribe();
    const fast = service.subscribe().stream[Symbol.asyncIterator]();
    for (let seq = 1; seq <= 10000; seq++) {
      service.broadcastEvent(event(seq));
      expect((await fast.next()).value?.seq).toBe(seq);
    }
    expect(slow.signal.aborted).toBe(true);
    expect(service.subscriberCount).toBe(1);
    await fast.return?.();
  });

  it("先重放游标后的持久事件，再继续输出实时事件", async () => {
    const durable = [event(1), event(2)];
    const service = new ApplicationEventService({
      latestEventSeq: () => durable.at(-1)?.seq ?? 0,
      listEvents: ({ afterSeq = 0, sessionId } = {}) =>
        durable.filter(
          (item) =>
            item.seq > afterSeq && (!sessionId || item.sessionId === sessionId),
        ),
    } as any);
    const subscription = service.subscribe({ after: 1, sessionId: "s1" });
    const iterator = subscription.stream[Symbol.asyncIterator]();

    expect(subscription.snapshotCursor).toBe(2);
    await expect(iterator.next()).resolves.toMatchObject({
      value: { seq: 2 },
      done: false,
    });

    const live = event(3);
    durable.push(live);
    service.broadcastEvent(live);
    await expect(iterator.next()).resolves.toMatchObject({
      value: { seq: 3 },
      done: false,
    });

    await iterator.return?.();
    expect(service.subscriberCount).toBe(0);
  });

  it("按 session 过滤，并在取消后清理订阅", async () => {
    const controller = new AbortController();
    const service = new ApplicationEventService({
      latestEventSeq: () => 0,
      listEvents: () => [],
    } as any);
    const iterator = service
      .subscribe({ sessionId: "s1", signal: controller.signal })
      .stream[Symbol.asyncIterator]();
    const next = iterator.next();

    service.broadcastEvent(event(1, "s2"));
    controller.abort();

    await expect(next).resolves.toEqual({ value: undefined, done: true });
    expect(service.subscriberCount).toBe(0);
  });

  it("支持查询历史事件并正确暴露最新游标", () => {
    const durable = [event(10), event(11), event(12)];
    const service = new ApplicationEventService({
      latestEventSeq: () => 12,
      listEvents: (options) =>
        durable.filter((e) => (options?.afterSeq !== undefined ? e.seq > options.afterSeq : true)),
    } as any);

    expect(service.list({ afterSeq: 10 })).toEqual([event(11), event(12)]);
    const subscription = service.subscribe();
    expect(subscription.snapshotCursor).toBe(12);
  });

  it("已中止的 signal 立即终止订阅", async () => {
    const controller = new AbortController();
    controller.abort();
    const service = new ApplicationEventService({
      latestEventSeq: () => 0,
      listEvents: () => [],
    } as any);

    const subscription = service.subscribe({ signal: controller.signal });
    const iterator = subscription.stream[Symbol.asyncIterator]();
    const result = await iterator.next();
    expect(result).toEqual({ value: undefined, done: true });
    expect(service.subscriberCount).toBe(0);
  });
});
