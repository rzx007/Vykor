import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@vykor/services";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createRunExecutionRoutes, type RunExecutionRoutesContext } from "../routes/run-execution.js";
import { assembleSessionRunServices } from "../../application/session/execution/session-run-assembly.js";
import { SessionEventPublisher } from "../../application/session/transcript/session-event-publisher.js";

let directory: string;
let store: SessionStore;
let runs: ReturnType<typeof assembleSessionRunServices>;
let app: ReturnType<typeof createRunExecutionRoutes>;
const source = "source";
const target = "target";
const instruction = `observe-session ${target}\r\nCheck progress.`;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "vykor-observe-admission-"));
  store = new SessionStore({ path: join(directory, "sessions.db") });
  for (const id of [source, target]) store.sessions.create({ id, cwd: process.cwd(), model: "test" });
  runs = assembleSessionRunServices({
    store,
    goals: store.goals,
    agentPool: { configured: true } as never,
    events: new SessionEventPublisher(store.conversations, {
      broadcastSince: () => {},
      broadcastEvent: () => {},
    }),
    assertReady: () => {},
    materializeSteerInput: async () => "",
    runExecutor: { execute: async () => {} },
    settleGoalRun: async () => {},
  });
  app = createRunExecutionRoutes({
    application: { admitPrompt: runs.admission.admitPromptAndMaybeRun.bind(runs.admission) } as RunExecutionRoutesContext["application"],
    traces: { get: () => undefined },
  });
});

afterEach(async () => {
  await runs.engine.runtimeBridge.waitForRuns(store.runs.listRuns(source).map(run => run.id));
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

function submit(body: Record<string, unknown>, sessionId = source) {
  return app.request(`/${sessionId}/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

it("records a fixed target Run and retains it when the same request is retried", async () => {
  store.runs.createRun({ sessionId: target, id: "older-queued" });
  store.runs.createRun({ sessionId: target, id: "active" });
  store.runs.updateRun("active", { status: "running" });
  const afterSeq = store.conversations.latestEventSeq();
  const request = { id: "observe", content: instruction };
  const admitted = await submit(request);
  expect(admitted.status).toBe(202);
  const result = await admitted.json();
  const grant = { targetSessionId: target, targetRunId: "active", afterSeq };
  expect(result.input.items).toEqual([{ type: "text", text: instruction }]);
  expect(store.runs.getRun(result.run.id)?.metadata.sessionObservationGrant).toEqual(grant);
  store.runs.updateRun("active", { status: "completed" });
  const retry = await submit(request);
  expect(retry.status).toBe(202);
  expect(await retry.json()).toMatchObject({ run: { id: result.run.id, metadata: { sessionObservationGrant: grant } } });
  expect(store.runs.listRuns(source)).toHaveLength(1);
});

it.each(["metadata", "runMetadata"])("rejects forged observation grants in %s", async field => {
  const response = await submit({ id: "forged", content: "plain prompt", [field]: {
    sessionObservationGrant: { targetSessionId: target, targetRunId: null, afterSeq: 0 },
  } });
  expect(response.status).toBe(400);
  expect(store.conversations.getInput("forged")).toBeUndefined();
});

it.each(["observe-session", "observe-session target suffix", "observe-session\ttarget"])("rejects a malformed directive (%s)", async content => {
  expect((await submit({ id: "bad", content })).status).toBe(400);
  expect(store.conversations.getInput("bad")).toBeUndefined();
});

it("rejects observation on steer and when promoting a queued prompt", async () => {
  expect((await submit({ id: "steer", content: instruction, delivery: "steer" })).status).toBe(409);
  expect(store.conversations.getInput("steer")).toBeUndefined();
  const response = await submit({ id: "queued", content: instruction });
  const { run } = await response.json();
  await expect(runs.control.promoteQueuedRun(source, "queued", run.id, "some-active-run")).rejects.toThrow(/observe-session/);
});

it.each([
  ["absent", 404], ["__proto__", 404], ["child", 409], ["temporary", 409], ["channel", 409], [source, 400],
] as const)("rejects observation of %s", async (id, status) => {
  if (id === "child") store.sessions.create({ id, parentId: target, cwd: process.cwd(), model: "test" });
  if (id === "temporary") store.sessions.create({ id, storage: "memory", cwd: process.cwd(), model: "test" });
  if (id === "channel") {
    store.sessions.create({ id, cwd: process.cwd(), model: "test" });
    store.channels.upsertConversation({ connector: "example", accountId: "account", chatId: "chat", sessionId: id });
  }
  expect((await submit({ id: "invalid-target", content: `observe-session ${id}` })).status).toBe(status);
  expect(store.conversations.getInput("invalid-target")).toBeUndefined();
});

it.each([true, false])("rejects a persisted retry with different observation intent (grant first: %s)", async grantFirst => {
  const ordinary = { id: "same-id", items: [{ type: "text", text: "" }, { type: "text", text: instruction }] };
  const observing = { id: "same-id", content: instruction };
  const first = await submit(grantFirst ? observing : ordinary);
  expect(first.status).toBe(202);
  const changed = await submit(grantFirst ? ordinary : observing);
  expect(changed.status).toBe(409);
  expect((await changed.json()).error).toMatch(/^prompt_id_conflict:/);
});

it("does not mint a grant when an older Input has to be recovered or replayed", async () => {
  store.conversationTransactions.admitPrompt({
    id: "orphan", sessionId: source, delivery: "queue", items: [{ type: "text", text: instruction }],
  });
  expect((await submit({ id: "orphan", content: instruction })).status).toBe(409);
  const response = await submit({
    id: "orphan", items: [{ type: "text", text: "" }, { type: "text", text: instruction }],
  });
  expect(response.status).toBe(202);
  const { run } = await response.json();
  expect(run.metadata).toMatchObject({ recoveredAdmission: true });
  expect(run.metadata.sessionObservationGrant).toBeUndefined();
  expect(runs.admission.replayInput("orphan", { id: "replay" }).run?.metadata.sessionObservationGrant).toBeUndefined();
  expect(() => runs.admission.replayInput("orphan", { metadata: { sessionObservationGrant: {} } })).toThrow(/reserved/);
});

it("does not infer a directive from another item or a later line", async () => {
  for (const items of [
    [{ type: "text", text: "" }, { type: "text", text: instruction }],
    [{ type: "text", text: "observe-" }, { type: "text", text: `session ${target}` }],
    [{ type: "text", text: `First line\n${instruction}` }],
  ]) {
    const response = await submit({ items });
    expect(response.status).toBe(202);
    const { run } = await response.json();
    expect(run.metadata.sessionObservationGrant).toBeUndefined();
  }
});

it("leaves queued Goal work in place when observation admission fails", async () => {
  const goal = store.goals.createGoal({ sessionId: source, objective: "Continue checking", maxAutoTurns: 2 });
  const queued = store.runs.createRun({
    sessionId: source,
    metadata: { goalId: goal.id, goalRunKind: "continuation" },
  });
  expect((await submit({ content: "observe-session missing" })).status).toBe(404);
  expect(store.runs.getRun(queued.id)?.status).toBe("pending");
  expect((await submit({ content: instruction })).status).toBe(202);
  expect(store.runs.getRun(queued.id)?.status).toBe("interrupted");
});

it("captures idle, then the oldest queued Run, then the most recently created terminal Run", async () => {
  const observe = async () => {
    const response = await submit({ content: instruction });
    expect(response.status).toBe(202);
    return (await response.json()).run.metadata.sessionObservationGrant.targetRunId;
  };
  expect(await observe()).toBeNull();
  store.runs.createRun({ sessionId: target, id: "first queued" });
  store.runs.createRun({ sessionId: target, id: "second queued" });
  expect(await observe()).toBe("first queued");
  store.runs.updateRun("second queued", { status: "completed" });
  store.runs.updateRun("first queued", { status: "completed" });
  expect(await observe()).toBe("second queued");
});

it("uses the real channel binding to deny observation from its source", async () => {
  store.channels.upsertConversation({ connector: "example", accountId: "account", chatId: "chat", sessionId: source });
  expect((await submit({ id: "bound-source", content: instruction })).status).toBe(409);
  expect(store.conversations.getInput("bound-source")).toBeUndefined();
});
