import { expect, it } from "vitest";
import { createLifecycleFixture } from "../../../../../../tests/agent-integration/__test__/fixtures/task-lifecycle-fixture.js";

it("reads bounded output from a real child run after a later run completed", async () => {
  const f = await createLifecycleFixture("sdk");
  try {
    const first = await f.spawn("abcdefghijklmnop");
    await first.handle.waitRun(first.target.runId);
    const receipt = await f.send(first.target, "next");
    await first.handle.waitRun(receipt.runId);
    const result = await f.agent.host.jobs.read({ sessionId: f.agent.id, target: first.target, maxChars: 4 });
    expect(result.text).toBe("mnop");
    expect(result.truncated).toBe(true);
    expect(result.snapshot.target).toEqual(first.target);
    await expect(f.agent.host.jobs.send({ sessionId: f.agent.id, target: first.target, data: "stale" })).rejects.toThrow(/conflict/);
  } finally { await f.close(); }
});

it("checks the expected run again when concurrent follow-ups reach admission", async () => {
  const f = await createLifecycleFixture("sdk");
  try {
    const first = await f.spawn("first");
    await first.handle.waitRun(first.target.runId);
    const request = { sessionId: f.agent.id, target: first.target, data: "next" };
    const results = await Promise.allSettled([f.agent.host.jobs.send(request), f.agent.host.jobs.send(request)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  } finally { await f.close(); }
});

it("returns canonical failure facts through live list, read and wait", async () => {
  const f = await createLifecycleFixture("sdk", { failure: { label: "budget-shape", kind: "max_turns" } });
  try {
    const first = await f.spawn("budget-shape");
    const waited = await f.wait(first.target);
    const read = await f.read(first.target);
    const listed = (await f.list()).jobs.find(job => job.id === first.target.jobId)!;
    for (const snapshot of [waited.snapshot, read.snapshot, listed]) {
      expect(snapshot.status).toBe("failed");
      expect(snapshot.target).toEqual(first.target);
      expect(snapshot.metadata?.childFailure).toMatchObject({ failureKind: "max_turns", partialResult: { runId: first.target.runId, source: "limit_finalization", truncated: true } });
      expect(snapshot.metadata).not.toHaveProperty("failureKind");
      expect(snapshot.metadata).not.toHaveProperty("partialResult");
    }
    const emptyWindow = await f.agent.host.jobs.read({ sessionId: f.agent.id, target: first.target, after: read.cursor });
    expect(emptyWindow.text).toBe("");
    expect(emptyWindow.snapshot.metadata?.childFailure).toEqual(read.snapshot.metadata?.childFailure);
  } finally { await f.close(); }
});
