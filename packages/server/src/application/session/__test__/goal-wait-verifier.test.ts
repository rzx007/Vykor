import { describe, expect, it } from "vitest";
import { GoalWaitVerifier } from "../goal-wait-verifier.js";

describe("GoalWaitVerifier", () => {
  it("verifies only runs and live children owned by the goal session", () => {
    const statuses = new Map([
      ["running", { id: "running", sessionId: "s1", status: "running" }],
      ["done", { id: "done", sessionId: "s1", status: "completed" }],
      ["foreign", { id: "foreign", sessionId: "s2", status: "running" }],
    ]);
    const verifier = new GoalWaitVerifier({
      store: { runs: { getRun: (id: string) => statuses.get(id) } } as never,
      liveChildren: {
        resolveRootSessionId: (id: string) =>
          id === "child" ? "s1" : undefined,
      },
      now: () => 1_000,
    });
    expect(
      verifier.check("s1", {
        kind: "external",
        handleId: "running",
        runId: "goal-run",
        deadlineAt: 2_000,
      }),
    ).toMatchObject({ state: "running" });
    expect(
      verifier.check("s1", {
        kind: "external",
        handleId: "done",
        runId: "goal-run",
        deadlineAt: 2_000,
      }),
    ).toEqual({ state: "completed" });
    expect(
      verifier.check("s1", {
        kind: "external",
        handleId: "child",
        runId: "goal-run",
        deadlineAt: 2_000,
      }),
    ).toMatchObject({ state: "running" });
    expect(
      verifier.check("s1", {
        kind: "external",
        handleId: "foreign",
        runId: "goal-run",
        deadlineAt: 2_000,
      }),
    ).toEqual({ state: "missing" });
    expect(
      verifier.check("s1", {
        kind: "external",
        handleId: "missing",
        runId: "goal-run",
        deadlineAt: 900,
      }),
    ).toMatchObject({ state: "failed" });
  });
});
