import { describe, expect, it } from "vitest";

import type { SessionEventRecord } from "@openharness/protocol";

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
