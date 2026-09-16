import { describe, expect, it, vi } from "vitest";
import type { SessionEventRecord } from "@openharness/protocol";

import { DaemonOperationGate } from "../../control/daemon-operation-gate.js";
import { ApplicationEventService } from "../../events/application-event-service.js";
import { SessionEventPublisher } from "../session-event-publisher.js";
import { SessionOperationRunner } from "../session-operation-runner.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createRunner(assertReady = vi.fn()) {
  const events = {
    checkpoint: vi.fn(() => 11),
    publishSince: vi.fn(),
  };
  const operationGate = new DaemonOperationGate();
  const runner = new SessionOperationRunner({
    sessions: {
      get: (id) => ({ id, cwd: `/repo/${id}` }) as any,
    },
    operationGate,
    events,
    assertReady,
  });
  return { runner, operationGate, events, assertReady };
}

function event(seq: number): SessionEventRecord {
  return {
    id: `event-${seq}`,
    seq,
    schemaVersion: 1,
    type: "session.updated",
    sessionId: "s1",
    payload: {},
    createdAt: seq,
  };
}

function createPublishedRunner() {
  const durable: SessionEventRecord[] = [];
  const store = {
    latestEventSeq: () => durable.at(-1)?.seq ?? 0,
    listEvents: ({ afterSeq = 0 } = {}) =>
      durable.filter((item) => item.seq > afterSeq),
  };
  const eventService = new ApplicationEventService(store);
  const publisher = new SessionEventPublisher(store, eventService);
  const runner = new SessionOperationRunner({
    sessions: { get: (id) => ({ id, cwd: `/repo/${id}` }) as any },
    operationGate: new DaemonOperationGate(),
    events: publisher,
  });
  return { durable, eventService, publisher, runner };
}

describe("SessionOperationRunner", () => {
  it("serializes work for the same session", async () => {
    const { runner } = createRunner();
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const order: string[] = [];

    const first = runner.run("s1", async () => {
      order.push("first:start");
      firstStarted.resolve();
      await releaseFirst.promise;
      order.push("first:end");
    });
    await firstStarted.promise;
    const second = runner.run("s1", async () => {
      order.push("second");
    });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("allows different sessions to run concurrently", async () => {
    const { runner } = createRunner();
    const release = deferred<void>();
    const started: string[] = [];

    const left = runner.run("left", async () => {
      started.push("left");
      await release.promise;
    });
    const right = runner.run("right", async () => {
      started.push("right");
      await release.promise;
    });
    await vi.waitFor(() => expect(started).toEqual(["left", "right"]));
    release.resolve();
    await Promise.all([left, right]);
  });

  it("does not run work when readiness or lease acquisition fails", async () => {
    const notReady = createRunner(() => {
      throw new Error("warming");
    });
    const work = vi.fn(async () => undefined);
    await expect(notReady.runner.run("s1", work)).rejects.toThrow("warming");
    expect(work).not.toHaveBeenCalled();

    const blocked = createRunner();
    const barrier = blocked.operationGate.tryEnterBarrier(
      { kind: "global" },
      () => true,
    )!;
    await expect(blocked.runner.run("s1", work)).rejects.toThrow(/blocked/);
    expect(work).not.toHaveBeenCalled();
    barrier.release();
  });

  it("releases the lease and publishes the durable boundary after errors", async () => {
    const { runner, operationGate, events } = createRunner();
    await expect(
      runner.run("s1", async () => {
        throw new Error("failed work");
      }),
    ).rejects.toThrow("failed work");
    expect(events.publishSince).toHaveBeenCalledOnce();
    expect(events.publishSince).toHaveBeenLastCalledWith(11);

    const barrier = operationGate.tryEnterBarrier(
      { kind: "session", sessionId: "s1", cwd: "/repo/s1" },
      () => true,
    );
    expect(barrier).toBeDefined();
    barrier!.release();

    await expect(runner.run("s1", async () => "ok")).resolves.toBe("ok");
    expect(events.checkpoint).toHaveBeenCalledTimes(2);
    expect(events.publishSince).toHaveBeenCalledTimes(2);
    expect(events.publishSince).toHaveBeenCalledWith(11);
  });

  it("does not enqueue a durable event twice when nested work already published it", async () => {
    const { durable, eventService, publisher, runner } = createPublishedRunner();
    const iterator = eventService.subscribe().stream[Symbol.asyncIterator]();

    await runner.run("s1", async () => {
      durable.push(event(1));
      publisher.publishSince(0);
    });
    durable.push(event(2));
    publisher.publish(event(2));

    await expect(iterator.next()).resolves.toMatchObject({ value: { seq: 1 } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { seq: 2 } });
    await iterator.return?.();
  });

  it("publishes durable events committed before work throws", async () => {
    const { durable, eventService, publisher, runner } = createPublishedRunner();
    const iterator = eventService.subscribe().stream[Symbol.asyncIterator]();

    await expect(
      runner.run("s1", async () => {
        durable.push(event(1));
        throw new Error("dispatch unavailable");
      }),
    ).rejects.toThrow("dispatch unavailable");
    durable.push(event(2));
    publisher.publish(event(2));

    await expect(iterator.next()).resolves.toMatchObject({ value: { seq: 1 } });
    await iterator.return?.();
  });
});
