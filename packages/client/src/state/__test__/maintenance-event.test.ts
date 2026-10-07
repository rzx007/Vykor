import { describe, expect, it } from "vitest";
import { applyEvent, createInitialClientState } from "../reducer.js";
describe("maintenance request facts", () => {
  it("advances the event cursor for an additive request-start fact without changing message state", () => {
    const state = createInitialClientState();
    const next = applyEvent(state, { id: "e", seq: 7, schemaVersion: 1, type: "session.model.attempt.started", sessionId: "s", createdAt: 1, payload: { runId: "r", generationId: "g", attempt: 1 } });
    expect(next.lastSeq).toBe(7); expect(next.buckets).toEqual(state.buckets);
    expect(applyEvent(next, { id: "e", seq: 7, schemaVersion: 1, type: "session.model.attempt.started", sessionId: "s", createdAt: 1, payload: { runId: "r", generationId: "g", attempt: 1 } })).toBe(next);
  });
});
