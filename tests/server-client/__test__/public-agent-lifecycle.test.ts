import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultNodeAgent } from "@vykor/agent-runtime";
import { VykorClient, selectSessionPermissions, syncEvents, waitForRun, type SyncEventUpdate } from "@rzx/client";
import { expect, it, vi } from "vitest";
import { startVykorServer } from "../../../packages/server/src/http/server.js";

async function observeRequest(updates: AsyncIterable<SyncEventUpdate>, sessionId: string, runId: string, toolName: string, live = false) {
  for await (const update of updates) {
    if (live && (update.source !== "live" || update.event?.type !== "permission.asked")) continue;
    const pending = selectSessionPermissions(update.state.buckets[sessionId]);
    const request = pending.find(item => item.status === "pending" && item.runId === runId && item.toolName === toolName);
    if (request) return request;
  }
  throw new Error(`No pending ${toolName} request for ${runId}`);
}

it("lets public clients hand off approval and questions and stop only the intended Run", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vykor-public-agent-"));
  vi.stubEnv("VYKOR_CONFIG_DIR", join(cwd, "config"));
  vi.stubEnv("VYKOR_DISABLE_MODELS_FETCH", "1");
  const token = "public-lifecycle-test";
  const model = "fixture";
  const target = join(cwd, "approved.txt");
  const answer = "简短中文";
  const signal = AbortSignal.timeout(15_000);
  let turn = 0;
  const owner = await startVykorServer({
    host: "127.0.0.1", port: 0, token, storePath: join(cwd, "session.db"), logger() {},
    services: { model: { list: () => [{
      name: "fixture", displayName: "Fixture",
      models: [{ id: model, label: "Fixture", provider: "fixture", providerName: "Fixture" }],
    }] } },
    async createAgent({ options }) {
      const agent = await createDefaultNodeAgent({
        ...options,
        approvalMode: "ask",
        permissionMode: "ask",
        settings: {
          ...options.settings!, model, apiFormat: "openai", maxTurns: 5,
          permission: { mode: "ask" }, sandbox: { enabled: false },
          plugins: { enabled: false }, memory: { enabled: false },
        },
        client: {
          async *streamMessage(params) {
            turn++;
            if (turn === 1) {
              yield { type: "tool_use_start", toolUse: {
                type: "tool_use", id: "fixture-write", name: "Write", input: { file_path: target, content: "approved" },
              } };
            } else if (turn === 2 || turn === 4) {
              yield { type: "tool_use_start", toolUse: {
                type: "tool_use", id: `fixture-question-${turn}`, name: "AskUser", input: { question: "使用哪种语言？" },
              } };
            } else {
              expect(JSON.stringify(params.messages)).toContain(answer);
              yield { type: "text_delta", delta: `已收到：${answer}` };
              yield { type: "complete", stopReason: "end_turn" };
              return;
            }
            yield { type: "complete", stopReason: "tool_use" };
          },
        },
      });
      return { agent, host: agent.host };
    },
  });
  try {
    const spec: { paths: Record<string, Record<string, unknown>> } = JSON.parse(readFileSync(
      new URL("../../../apps/client-docs/public/agent-openapi.json", import.meta.url), "utf8",
    ));
    const routes = new Set(owner.server.app.routes.map(route =>
      `${route.method} ${route.path.replace(/:[^/]+/g, ":param")}`));
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const method of Object.keys(operations)) {
        expect(routes).toContain(`${method.toUpperCase()} ${path.replace(/\{[^}]+\}/g, ":param")}`);
      }
    }
    const first = new VykorClient({ baseUrl: owner.listen.url, token });
    const second = new VykorClient({ baseUrl: owner.listen.url, token });
    const models = await first.runtime.listModels({ signal });
    const session = await first.sessions.create({ cwd, model: models[0]!.models[0]!.id }, { signal });
    const prompt = { id: "first-input", items: [{ type: "text" as const, text: "写入测试文件后询问我" }] };
    const admission = await first.sessions.admitPrompt(session.id, prompt, { signal });
    const runId = admission.run!.id;
    const write = await observeRequest(syncEvents(first, { sessionId: session.id, signal }), session.id, runId, "Write");
    // The first observer disconnected while approval was pending. The second reads its snapshot.
    await expect(second.sessions.admitPrompt(session.id, prompt, { signal })).resolves.toMatchObject({ run: { id: runId } });
    await expect(second.sessions.admitPrompt(session.id, {
      ...prompt, items: [{ type: "text", text: "同一 ID 的不同内容" }],
    }, { signal })).rejects.toMatchObject({ status: 409 });
    const takeOver = syncEvents(second, { sessionId: session.id, signal })[Symbol.asyncIterator]();
    let question;
    try {
      const update = await takeOver.next();
      if (update.done) throw new Error("The takeover observer ended before its snapshot");
      const attached = update.value;
      expect(attached.source).toBe("snapshot");
      expect(selectSessionPermissions(attached.state.buckets[session.id])).toContainEqual(
        expect.objectContaining({ id: write.id, status: "pending" }),
      );
      await second.permissions.reply(write.id, { status: "approved", decision: "once" }, { signal });
      // AskUser must arrive on the stream opened from the takeover snapshot's cursor.
      question = await observeRequest({ [Symbol.asyncIterator]: () => takeOver }, session.id, runId, "AskUser", true);
    } finally {
      await takeOver.return?.();
    }
    expect(question.payload.input).toMatchObject({ kind: "question", question: "使用哪种语言？" });
    await second.permissions.reply(question.id, { status: "approved", decision: "once", answer }, { signal });
    await expect(first.permissions.reply(question.id, { status: "denied" }, { signal })).rejects.toMatchObject({ status: 409 });
    const result = await waitForRun(second, { sessionId: session.id, runId, signal });
    expect(result.run.status).toBe("completed");
    expect(result.messages.flatMap(message => message.parts)).toContainEqual(expect.objectContaining({ text: `已收到：${answer}` }));
    expect(readFileSync(target, "utf8")).toBe("approved");
    const events = await second.events.list({ sessionId: session.id, signal, limit: 200 });
    expect(events.filter(event => event.type === "permission.asked").map(event => event.payload.request)).toEqual([
      expect.objectContaining({ id: write.id }), expect.objectContaining({ id: question.id }),
    ]);
    expect(events.filter(event => event.type === "permission.replied").map(event => event.payload.request)).toEqual([
      expect.objectContaining({ id: write.id }), expect.objectContaining({ id: question.id }),
    ]);

    const blocked = await second.sessions.admitPrompt(session.id, {
      id: "new-input", items: [{ type: "text", text: "等待中断" }],
    }, { signal });
    const blockedId = blocked.run!.id;
    const blockedQuestion = await observeRequest(syncEvents(second, { sessionId: session.id, signal }), session.id, blockedId, "AskUser");
    await expect(first.sessions.interrupt(session.id, { expectedRunId: runId, signal })).resolves.toMatchObject({ interrupted: false });
    expect(await second.permissions.list({ sessionId: session.id, status: "pending", signal })).toContainEqual(expect.objectContaining({ id: blockedQuestion.id }));
    await expect(first.sessions.interrupt(session.id, { expectedRunId: blockedId, signal })).resolves.toMatchObject({ interrupted: true });
    expect((await waitForRun(first, { sessionId: session.id, runId: blockedId, signal })).run.status).toBe("interrupted");
  } finally {
    await owner.server.close();
    vi.unstubAllEnvs();
    rmSync(cwd, { force: true, recursive: true });
  }
}, 30_000);
