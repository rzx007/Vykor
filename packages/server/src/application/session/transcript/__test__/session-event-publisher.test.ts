import { describe, expect, it, vi } from "vitest";

import { SessionEventPublisher } from "../session-event-publisher.js";

describe("SessionEventPublisher", () => {
  it("captures the store cursor and forwards persisted and live events", () => {
    const event = { seq: 8, type: "session.updated", payload: {} };
    const sink = {
      broadcastSince: vi.fn(),
      broadcastEvent: vi.fn(),
    };
    const events = new SessionEventPublisher({ latestEventSeq: () => 7 } as any, sink);

    expect(events.checkpoint()).toBe(7);
    events.publishSince(7);
    events.publish(event as any);

    expect(sink.broadcastSince).toHaveBeenCalledWith(7);
    expect(sink.broadcastEvent).toHaveBeenCalledWith(event);
  });
});
