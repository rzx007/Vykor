import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { VykorClient, waitForRun } from "@rzx/client";
import { createDefaultNodeAgent } from "@vykor/agent-runtime";
import { startVykorServer } from "../../../packages/server/src/http/server.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(ready => { resolve = ready; });
  return { promise, resolve };
}

it("binds HTTP follow-ups to one Run and distinguishes admission from model history", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vykor-follow-up-"));
  vi.stubEnv("VYKOR_CONFIG_DIR", join(cwd, "config"));
  vi.stubEnv("VYKOR_DISABLE_MODELS_FETCH", "1");
  const storePath = join(cwd, "session.db");
  const token = "running-follow-up-test";
  const firstRequest = gate();
  const finishFirstRequest = gate();
  const pausedRequest = gate();
  const releasePausedRequest = gate();
  const histories: string[] = [];
  const file = join(cwd, "fixture.txt");
  writeFileSync(file, "once");
  const owner = await startVykorServer({
    host: "127.0.0.1", port: 0, token, storePath, logger() {},
    async createAgent({ options }) {
      const agent = await createDefaultNodeAgent({
        ...options,
        approvalMode: "full_access",
        permissionMode: "full_access",
        settings: {
          ...options.settings!, model: "m", apiFormat: "openai", maxTurns: 5,
          permission: { mode: "full_access" }, sandbox: { enabled: false },
          plugins: { enabled: false }, memory: { enabled: false },
        },
        client: {
          async *streamMessage(params) {
            const history = JSON.stringify(params.messages);
            histories.push(history);
            if (histories.length === 1) {
              firstRequest.resolve();
              await finishFirstRequest.promise;
              yield { type: "tool_use_start", toolUse: {
                type: "tool_use", id: "read-once", name: "Read", input: { file_path: file },
              } };
              yield { type: "complete", stopReason: "tool_use" };
              return;
            }
            if (params.messages.at(-1)?.content === "wait for stop") {
              pausedRequest.resolve();
              await releasePausedRequest.promise;
            }
            yield { type: "text_delta", delta: "done" };
            yield { type: "complete", stopReason: "end_turn" };
          },
        },
      });
      return { agent, host: agent.host };
    },
  });
  try {
    const client = new VykorClient({ baseUrl: owner.listen.url, token });
    const session = await client.sessions.create({ cwd, model: "m" });
    const send = (id: string, content: string, expectedActiveRunId?: string) =>
      client.sessions.admitPrompt(session.id, {
        id, items: [{ type: "text", text: content }],
        ...(expectedActiveRunId ? { delivery: "steer", expectedActiveRunId } : {}),
      });
    const wait = (runId: string) => waitForRun(client, {
      sessionId: session.id, runId, signal: AbortSignal.timeout(8_000),
    });
    const { run: initial } = await send("initial", "read once");
    const runId = initial!.id;
    await firstRequest.promise;
    const queued = await send("queued", "queued then promoted");
    const promotion = client.sessions.promoteQueuedPrompt(session.id, "queued", {
      queuedRunId: queued.run!.id, expectedActiveRunId: runId,
    });
    void promotion.catch(() => {});
    await vi.waitFor(() => {
      expect(owner.server.store.runs.getRun(queued.run!.id)?.metadata.promotion)
        .toMatchObject({ kind: "steering", activeRunId: runId });
    });
    let replied = false;
    const followUp = send("during", "revise instructions", runId).finally(() => { replied = true; });
    void followUp.catch(() => {});
    await vi.waitFor(async () => {
      const state = await client.sessions.getState(session.id);
      expect(state.inputs.find(input => input.id === "during")?.metadata.steerTargetRunId).toBe(runId);
      expect(state.messages.some(message => message.inputId === "during")).toBe(false);
      expect(state.runs.find(run => run.id === runId)?.metadata.appliedInputState)
        .toEqual({ revision: 1, inputIds: ["initial"] });
    });
    expect(replied).toBe(false);
    finishFirstRequest.resolve();
    expect((await followUp).run?.id).toBe(runId);
    await promotion;
    expect((await wait(runId)).run.status).toBe("completed");
    const final = await client.sessions.getState(session.id);
    expect(final.runs.find(run => run.id === runId)?.metadata.appliedInputState)
      .toMatchObject({ inputIds: ["initial", "queued", "during"] });
    expect(final.runs.find(run => run.id === queued.run!.id)).toMatchObject({
      status: "interrupted", metadata: { promotion: { kind: "steered", activeRunId: runId } },
    });
    expect(final.messages.filter(message => message.inputId === "queued")).toHaveLength(1);
    expect(final.messages.filter(message => message.inputId === "during")).toHaveLength(1);
    expect(histories.some(history => history.includes("revise instructions"))).toBe(true);
    expect(final.parts.filter(part => part.type === "tool" && part.toolUseId === "read-once")).toHaveLength(1);

    const newer = await send("newer", "wait for stop");
    const newerRunId = newer.run!.id;
    await pausedRequest.promise;
    const queuedBeforeStop = await send("queued-before-stop", "keep the unapplied promotion");
    const queuedBeforeStopId = queuedBeforeStop.run!.id;
    const promotionAtStop = client.sessions.promoteQueuedPrompt(session.id, "queued-before-stop", {
      queuedRunId: queuedBeforeStopId, expectedActiveRunId: newerRunId,
    });
    void promotionAtStop.catch(() => {});
    await vi.waitFor(() => {
      expect(owner.server.store.runs.getRun(queuedBeforeStopId)?.metadata.promotion)
        .toMatchObject({ kind: "steering", activeRunId: newerRunId });
    });
    await expect(send("during", "revise instructions", runId)).resolves.toMatchObject({ run: { id: runId } });
    await expect(send("stale", "must not reach the new Run", runId)).rejects.toMatchObject({ status: 409 });
    const stopped = send("before-stop", "must never get applied", newerRunId);
    void stopped.catch(() => {});
    await vi.waitFor(() => expect(owner.server.store.conversations.getInput("before-stop")).toBeTruthy());
    await expect(client.sessions.interrupt(session.id, { expectedRunId: newerRunId })).resolves.toBeDefined();
    releasePausedRequest.resolve();
    await expect(stopped).rejects.toMatchObject({ status: 409 });
    await expect(promotionAtStop).rejects.toBeDefined();
    expect((await wait(newerRunId)).run.status).toBe("interrupted");
    expect(owner.server.store.conversations.getInput("stale")).toBeFalsy();
    expect(histories.some(history => /must never get applied|must not reach/.test(history))).toBe(false);
    const stoppedState = await client.sessions.getState(session.id);
    expect(stoppedState.messages.some(message => message.inputId === "before-stop")).toBe(false);
    expect(stoppedState.messages.some(message => message.inputId === "queued-before-stop")).toBe(false);
    expect(stoppedState.inputs.filter(input => input.id === "queued-before-stop")).toHaveLength(1);
    expect(stoppedState.runs.find(run => run.id === queuedBeforeStopId)).toMatchObject({
      status: "interrupted", metadata: { promotion: { kind: "failed", activeRunId: newerRunId } },
    });
  } finally {
    finishFirstRequest.resolve();
    releasePausedRequest.resolve();
    await owner.server.close();
    vi.unstubAllEnvs();
    rmSync(cwd, { force: true, recursive: true });
  }
}, 25_000);
