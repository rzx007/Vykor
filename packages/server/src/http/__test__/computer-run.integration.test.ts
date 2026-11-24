import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { StreamEvent, StreamMessageParams, StreamingMessageClient } from "@vykor/agent-contracts";
import { ModelRequestFailure } from "@vykor/agent-contracts";
import { createDefaultNodeAgent } from "@vykor/agent-runtime";
import { CURRENT_PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from "@vykor/protocol";
import type { BrowserHost } from "../../application/browser-tools/browser-host.js";
import {
  COMPUTER_HOST_TOKEN_HEADER,
  COMPUTER_SESSION_UNAVAILABLE,
  parseComputerBridgeEvent,
  type ComputerBridgeEvent,
} from "../../application/computer-tools/computer-bridge-protocol.js";
import type { AdmitPromptResult } from "../../application/session/execution/run-admission-service.js";
import { VykorHttpServer } from "../server.js";

const headers = {
  authorization: "Bearer api-test-token",
  [PROTOCOL_VERSION_HEADER]: String(CURRENT_PROTOCOL_VERSION),
};
const computerToken = "ae".repeat(32);
const desktopHeaders = { ...headers, [COMPUTER_HOST_TOKEN_HEADER]: computerToken };
const sessionId = "computer-root";
const text = "Observe this application's status";
const input = (id: string) => ({ id, items: [{ type: "text", text }] });
const frame = {
  mediaType: "image/png",
  width: 1,
  height: 1,
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHuoAAAAASUVORK5CYII=",
};

async function fixture(
  mode: "full_access" | "ask",
  action: string | { action: "capture"; purpose: "result" } = "observe",
  modelResponse?: (params: StreamMessageParams, call: number) => void | AsyncIterable<StreamEvent>,
  browserHost?: BrowserHost,
  supportsImage = action === "capture",
) {
  const toolInput = typeof action === "string" ? { action } : action;
  const directory = mkdtempSync(join(tmpdir(), "vk-computer-run-"));
  const requests: StreamMessageParams[] = [];
  const client: StreamingMessageClient = {
    async *streamMessage(params) {
      requests.push({ ...params, messages: structuredClone(params.messages) });
      const simulated = modelResponse?.(params, requests.length);
      if (simulated) {
        yield* simulated;
        return;
      }
      const afterPrompt = params.messages.slice(params.messages.findLastIndex(message => message.type === "user") + 1);
      const toolUseId = "observe-" + params.messages.filter(message => message.type === "user").length;
      if (params.tools?.some(tool => tool.name === "Computer")
        && !afterPrompt.some(message => message.type === "tool_result" && message.toolUseId === toolUseId)) {
        yield { type: "tool_use_start", toolUse: { type: "tool_use", id: toolUseId, name: "Computer", input: toolInput } };
        yield { type: "complete", stopReason: "tool_use" };
        return;
      }
      yield { type: "text_delta", delta: "Finished." };
      yield { type: "complete", stopReason: "end_turn" };
    },
  };
  const server = new VykorHttpServer({
    token: "api-test-token",
    desktopComputerToken: computerToken,
    browserHost,
    storePath: join(directory, "sessions.db"),
    settings: {
      model: "test-model", apiFormat: "openai", maxTurns: 7,
      permission: { mode }, plugins: { enabled: false }, memory: { enabled: false }, sandbox: { enabled: false },
    },
    async createAgent({ options }) {
      const agent = await createDefaultNodeAgent({ ...options, client,
        resolveModelImageSupport: async () => supportsImage,
      });
      return { agent, host: agent.host };
    },
    logger: () => {},
  });
  const openReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  const post = (path: string, body: unknown, requestHeaders = headers) => server.app.request(path, {
    method: "POST",
    headers: { ...requestHeaders, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const create = (id: string, extra: Record<string, unknown> = {}) =>
    post("/sessions", { id, cwd: directory, model: "test-model", ...extra });
  const run = async (response: Response) => {
    const admitted = await response.json() as AdmitPromptResult;
    expect(response.status, JSON.stringify(admitted)).toBe(202);
    expect(admitted.run?.id).toBeTruthy();
    return { sessionId: admitted.input.sessionId, runId: admitted.run!.id, inputId: admitted.input.id };
  };
  const awaitRun = (identity: Awaited<ReturnType<typeof run>>) =>
    server.application.runControl.awaitRun(identity.sessionId, identity.runId, { timeoutMs: 10_000 });
  const open = async () => {
    const response = await server.app.request("/computer-host/stream", { headers: desktopHeaders });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    openReaders.add(reader);
    async function next(): Promise<ComputerBridgeEvent> {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Computer stream closed");
        const event = new TextDecoder().decode(chunk.value);
        if (event.startsWith("data: ")) return parseComputerBridgeEvent(JSON.parse(event.slice(6).trim()));
      }
    }
    const hello = await next();
    if (hello.type !== "connected") throw new Error("Expected the new Computer connection");
    const path = "/computer-host/" + hello.connectionId;
    return {
      next,
      submit: (target: string, prompt: Record<string, unknown>) =>
        post(path + "/submit", { sessionId: target, input: prompt }, desktopHeaders),
      result: (requestId: string, result: Record<string, unknown> = { text: "Verified fake window" }) =>
        post(path + "/" + requestId + "/result", { result }, desktopHeaders),
      dispatch: (requestId: string) => post(path + "/" + requestId + "/dispatch", {}, desktopHeaders),
      error: (requestId: string, executionState: "unknown" | "not_started") =>
        post(path + "/" + requestId + "/result", { error: "Windows fixture outcome", executionState }, desktopHeaders),
      revokeImage: (requestId: string, auth = desktopHeaders) =>
        post(path + "/" + requestId + "/revoke-image", {}, auth),
      close: async () => { await reader.cancel(); openReaders.delete(reader); },
    };
  };
  const close = async () => {
    await Promise.all([...openReaders].map(reader => reader.cancel()));
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    await server.listen();
    const created = await create(sessionId);
    expect(created.status, await created.text()).toBe(201);
    return { server, requests, post, create, run, awaitRun, open, close, directory };
  } catch (error) {
    await close();
    throw error;
  }
}

it("corrects redundant observe parameters without dispatching them to Desktop", async () => {
  const f = await fixture("full_access", "observe", async function* (_params, call) {
    if (call === 1) {
      yield { type: "tool_use_start", toolUse: {
        type: "tool_use", id: "invalid-observe", name: "Computer", input: { action: "observe", app: "Calculator" },
      } };
    } else if (call === 2) {
      yield { type: "tool_use_start", toolUse: {
        type: "tool_use", id: "corrected-observe", name: "Computer", input: { action: "observe" },
      } };
    }
    yield { type: "complete", stopReason: call < 3 ? "tool_use" : "end_turn" };
  });
  try {
    const desktop = await f.open();
    const run = await f.run(await desktop.submit(sessionId, input("observe-parameters")));
    const observed = await desktop.next();
    expect(observed).toMatchObject({ type: "execute", action: { type: "observe" } });
    if (observed.type !== "execute") throw new Error("Expected the corrected observation");
    expect((await desktop.result(observed.requestId)).ok).toBe(true);
    expect(await f.awaitRun(run)).toMatchObject({ status: "completed" });
    const feedback = f.requests[1]?.messages.find(message => message.type === "tool_result" && message.toolUseId === "invalid-observe");
    expect(feedback?.content).toContainEqual(expect.objectContaining({
      type: "text", text: expect.stringContaining('{"action":"observe"}'),
    }));
  } finally { await f.close(); }
});

it.each(["deliver", "revoke", "stop", "import-failed", "revoke-during-import"] as const)("handles a result screenshot before final delivery: %s", async outcome => {
  const finishAnswer = Promise.withResolvers<void>();
  const f = await fixture("full_access", { action: "capture", purpose: "result" }, (_params, call) => {
    if (call !== 2) return;
    return (async function* (): AsyncIterable<StreamEvent> {
      await finishAnswer.promise;
      yield { type: "text_delta", delta: "The result is 56." };
      yield { type: "complete", stopReason: "end_turn" };
    })();
  });
  const importStarted = Promise.withResolvers<AbortSignal>();
  const releaseImport = Promise.withResolvers<void>();
  try {
    if (outcome === "import-failed") {
      vi.spyOn(f.server.application.attachments, "import").mockRejectedValueOnce(new Error("fixture import failed"));
    } else if (outcome === "revoke-during-import") {
      const attachments = f.server.application.attachments;
      const actualImport = attachments.import.bind(attachments);
      vi.spyOn(attachments, "import").mockImplementationOnce(input => {
        const content = input.content.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          async flush() {
            importStarted.resolve(input.signal!);
            await releaseImport.promise;
          },
        }));
        return actualImport({ ...input, content });
      });
    }
    const desktop = await f.open();
    const run = await f.run(await desktop.submit(sessionId, input("result-screenshot")));
    const captured = await desktop.next();
    expect(captured).toMatchObject({ type: "execute", action: { type: "capture", purpose: "result" } });
    if (captured.type !== "execute") throw new Error("Expected the result capture");
    expect((await desktop.result(captured.requestId, { text: '{"status":"captured"}', image: frame })).status).toBe(200);
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    expect(f.server.store.conversations.listMessageParts(sessionId).some(part => part.type === "attachment")).toBe(false);
    if (outcome === "revoke") expect((await desktop.revokeImage(captured.requestId)).status).toBe(200);
    if (outcome === "stop") expect((await f.post(`/sessions/${sessionId}/interrupt`, { expectedRunId: run.runId })).ok).toBe(true);
    finishAnswer.resolve();
    if (outcome === "revoke-during-import") {
      const signal = await importStarted.promise;
      try {
        expect((await desktop.revokeImage(captured.requestId)).status).toBe(200);
        expect(signal.aborted).toBe(true);
      } finally { releaseImport.resolve(); }
    }
    expect(await f.awaitRun(run)).toMatchObject({ status: outcome === "stop" ? "interrupted" : "completed" });
    expect(JSON.stringify(f.requests)).not.toContain(frame.data);
    const parts = f.server.store.conversations.listMessageParts(sessionId);
    const attachments = parts.filter(part => part.type === "attachment");
    if (outcome === "deliver") {
      const answer = parts.find(part => part.type === "text" && part.text === "The result is 56.");
      expect(answer).toBeDefined();
      expect(attachments).toEqual([expect.objectContaining({ messageId: answer?.messageId, mediaType: "image/png" })]);
      expect(attachments[0]!.seq).toBeGreaterThan(answer!.seq);
      const asset = await f.server.application.attachments.openContent(attachments[0]!.assetId!);
      expect(Buffer.from(await new Response(asset.content).arrayBuffer()).toString("base64")).toBe(frame.data);
    } else {
      expect(attachments).toEqual([]);
    }
    const screenshotError = parts.find(part => part.type === "error" && part.id === `computer-screenshot:${run.runId}`);
    if (outcome === "import-failed") {
      expect(screenshotError?.text).toContain("截图未能保存");
    } else {
      expect(screenshotError).toBeUndefined();
    }
    if (outcome === "revoke-during-import") {
      expect(f.server.store.attachments.listAttachments()).toMatchObject([{ status: "failed", failureCode: "attachment_aborted" }]);
    }
  } finally { finishAnswer.resolve(); releaseImport.resolve(); await f.close(); }
}, 20_000);

it("attaches a window image to one model request and keeps it out of durable history", async () => {
  const f = await fixture("full_access", "capture");
  const { data } = frame;
  vi.stubEnv("VYKOR_DATA_DIR", f.directory);
  try {
    const desktop = await f.open();
    const trusted = await f.run(await desktop.submit(sessionId, input("image")));
    const dispatched = await desktop.next();
    if (dispatched.type !== "execute") throw new Error("Expected the Computer capture");
    expect(dispatched.action).toEqual({ type: "capture" });
    expect((await desktop.result(dispatched.requestId, { text: "Captured fixture window", image: frame })).status).toBe(200);
    expect(await f.awaitRun(trusted)).toMatchObject({ status: "completed" });
    expect(await desktop.next()).toEqual({ type: "ended", run: trusted });
    expect(f.requests.at(-1)?.messages.findLast(message => message.type === "tool_result")).toMatchObject({
      content: expect.arrayContaining([
        { type: "text", text: "Captured fixture window" }, { type: "image", source: { type: "memory", ...frame } },
      ]),
    });
    const parts = f.server.store.conversations.listMessageParts(sessionId);
    const events = f.server.store.conversations.listEvents({ sessionId });
    expect(JSON.stringify(parts)).toContain("Captured fixture window");
    expect(JSON.stringify([parts, events])).not.toContain(data);
    expect(f.server.store.conversations.listSessionInputAttachments(sessionId)).toEqual([]);
    const filename = join(f.directory, "capture-export.json");
    const exported = await f.post(`/sessions/${sessionId}/export`, { format: "json", filename });
    expect(exported.status).toBe(200);
    const history = readFileSync(filename, "utf8");
    expect(history).toContain("Captured fixture window");
    expect(history).not.toContain(data);
    for (const file of readdirSync(f.directory).filter(name => name.startsWith("sessions.db"))) {
      expect(readFileSync(join(f.directory, file)).includes(data)).toBe(false);
    }
    const next = await f.run(await f.post(`/sessions/${sessionId}/prompts`, input("ordinary-after-capture")));
    expect(await f.awaitRun(next)).toMatchObject({ status: "completed" });
    expect(JSON.stringify(f.requests.at(-1)?.messages)).not.toContain(data);
  } finally { vi.unstubAllEnvs(); await f.close(); }
}, 20_000);

it("revokes an exact capture before its delayed result and leaves a later capture valid", async () => {
  const f = await fixture("full_access", "capture");
  try {
    const desktop = await f.open();
    const first = await f.run(await desktop.submit(sessionId, input("revoked-image")));
    const captured = await desktop.next();
    if (captured.type !== "execute") throw new Error("Expected the Computer capture");
    expect((await desktop.revokeImage(captured.requestId, headers)).status).toBe(401);
    expect((await desktop.revokeImage(captured.requestId)).status).toBe(200);
    expect((await desktop.result(captured.requestId, { text: "Late capture", image: frame })).status).toBe(200);
    expect(await f.awaitRun(first)).toMatchObject({ status: "completed" });
    expect(JSON.stringify(f.requests)).not.toContain(frame.data);
    expect(await desktop.next()).toEqual({ type: "ended", run: first });

    const second = await f.run(await desktop.submit(sessionId, input("new-image")));
    const newer = await desktop.next();
    if (newer.type !== "execute") throw new Error("Expected the new Computer capture");
    expect((await desktop.revokeImage(captured.requestId)).status).toBe(404);
    expect((await desktop.result(newer.requestId, { text: "Current capture", image: frame })).status).toBe(200);
    expect(await f.awaitRun(second)).toMatchObject({ status: "completed" });
    expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain(frame.data);
  } finally { await f.close(); }
}, 20_000);

it("keeps an attached capture out of a subsequent provider retry", async () => {
  const f = await fixture("full_access", "capture", (_params, call) => {
    if (call === 2) throw new ModelRequestFailure("Temporary upstream failure", {
      phase: "request", kind: "network", retryable: true,
    });
  });
  try {
    const desktop = await f.open();
    const run = await f.run(await desktop.submit(sessionId, input("retry-image")));
    const captured = await desktop.next();
    if (captured.type !== "execute") throw new Error("Expected the Computer capture");
    expect((await desktop.result(captured.requestId, { text: "Capture before retry", image: frame })).status).toBe(200);
    expect(await f.awaitRun(run)).toMatchObject({ status: "completed" });
    expect(f.requests.map(request => JSON.stringify(request.messages).includes(frame.data))).toEqual([false, true, false]);
  } finally { await f.close(); }
}, 20_000);

it.each([frame.data, frame.data.slice(0, 32)])("keeps an echoed screenshot payload out of durable failures", async echoed => {
  const sensitive = `data:${frame.mediaType};base64,${echoed}`;
  const f = await fixture("full_access", "capture", (_params, call) => {
    if (call !== 2) return;
    return (async function* (): AsyncIterable<StreamEvent> {
      // A compatible endpoint may also echo request data in open-ended usage fields.
      yield { type: "usage", usage: {
        inputTokens: 4, outputTokens: 0, metering: {
          knownInputTokens: 4, knownOutputTokens: 0, inputIncludesCache: true, completeness: "partial",
          raw: { upstreamEcho: sensitive },
        },
      } };
      throw new ModelRequestFailure(`Upstream rejected "${sensitive}"`, {
        phase: "request", kind: "invalid_request", retryable: false, requestId: sensitive,
      }, new Error(sensitive));
    })();
  });
  try {
    const desktop = await f.open();
    const run = await f.run(await desktop.submit(sessionId, input("failed-image")));
    const captured = await desktop.next();
    if (captured.type !== "execute") throw new Error("Expected the Computer capture");
    expect((await desktop.result(captured.requestId, { text: "Image before failure", image: frame })).status).toBe(200);
    const settled = await f.awaitRun(run);
    expect(settled).toMatchObject({ status: "failed" });
    expect(JSON.stringify(settled)).not.toContain(echoed);
    const events = f.server.store.conversations.listEvents({ sessionId });
    expect(events.filter(event => event.type === "session.model.attempt.finished").at(-1)?.payload)
      .toMatchObject({ attemptUsage: { usage: { inputTokens: 4, outputTokens: 0 } } });
    expect(JSON.stringify(events)).not.toContain(echoed);
    for (const file of readdirSync(f.directory).filter(name => name.startsWith("sessions.db"))) {
      expect(readFileSync(join(f.directory, file)).includes(echoed)).toBe(false);
    }
  } finally { await f.close(); }
}, 20_000);

it("lets a fresh visual observation verify foreground input without a semantic read", async () => {
  const steps = [{ action: "key", key: "Enter" }, { action: "capture" }, { action: "capture", purpose: "result" }];
  const f = await fixture("full_access", "capture", async function* (_params, call) {
    const input = steps[call - 1];
    if (!input) {
      yield { type: "text_delta", delta: "Here is the result." };
      yield { type: "complete", stopReason: "end_turn" };
      return;
    }
    yield { type: "tool_use_start", toolUse: { type: "tool_use", id: `visual-${call}`, name: "Computer", input } };
    yield { type: "complete", stopReason: "tool_use" };
  });
  try {
    const desktop = await f.open();
    const run = await f.run(await desktop.submit(sessionId, input("visual-verify")));
    const key = await desktop.next();
    if (key.type !== "execute") throw new Error("Expected foreground input");
    expect(await desktop.dispatch(key.requestId)).toMatchObject({ ok: true });
    expect(await desktop.result(key.requestId, { status: "sent", text: "Enter was sent" })).toMatchObject({ ok: true });
    for (const action of [{ type: "capture" }, { type: "capture", purpose: "result" }]) {
      const capture = await desktop.next();
      if (capture.type !== "execute") throw new Error("Expected visual capture");
      expect(capture.action).toEqual(action);
      expect(await desktop.result(capture.requestId, { text: "Visible result", image: frame })).toMatchObject({ ok: true });
    }
    expect(await f.awaitRun(run)).toMatchObject({ status: "completed" });
  } finally { await f.close(); }
});

it.each(["text-only", "same generation"] as const)("does not count an unseen visual capture as verification (%s)", async mode => {
  const f = await fixture("full_access", "capture", async function* (_params, call) {
    const actions = call === 1 ? [{ action: "key", key: "Enter" }]
      : call === 2 ? [{ action: "capture" }, ...(mode === "same generation" ? [{ action: "capture", purpose: "result" }] : [])]
        : call === 3 && mode === "text-only" ? [{ action: "capture", purpose: "result" }]
          : [];
    for (const [index, input] of actions.entries())
      yield { type: "tool_use_start", toolUse: { type: "tool_use", id: `verify-${call}-${index}`, name: "Computer", input } };
    yield { type: "complete", stopReason: actions.length ? "tool_use" : "end_turn" };
  }, undefined, mode !== "text-only");
  try {
    const desktop = await f.open();
    const run = await f.run(await desktop.submit(sessionId, input("unseen-visual")));
    const key = await desktop.next();
    if (key.type !== "execute") throw new Error("Expected foreground input");
    expect((await desktop.dispatch(key.requestId)).ok).toBe(true);
    expect((await desktop.result(key.requestId, { status: "sent", text: "Key sent" })).ok).toBe(true);
    const capture = await desktop.next();
    if (capture.type !== "execute") throw new Error("Expected visual capture");
    expect((await desktop.result(capture.requestId, { text: "Window captured", image: frame })).ok).toBe(true);
    expect(await desktop.next()).toEqual({ type: "ended", run });
    const blocked = f.requests.at(-1)?.messages.findLast(message => message.type === "tool_result");
    expect(blocked).toMatchObject({ isError: true, executionState: "not_started" });
  } finally { await f.close(); }
});

it("keeps an uncertain action in history, blocks another mutation and still permits observation", async () => {
  const steps = [
    { action: "open_app", app: "Notepad" },
    { action: "open_app", app: "Calculator" },
    { action: "observe" },
    { action: "open_app", app: "Paint" },
  ];
  const f = await fixture("full_access", "observe", async function* (_params, call) {
    const step = steps[call - 1];
    if (!step) {
      yield { type: "complete", stopReason: "end_turn" };
      return;
    }
    yield { type: "tool_use_start", toolUse: { type: "tool_use", id: `computer-${call}`, name: "Computer", input: step } };
    yield { type: "complete", stopReason: "tool_use" };
  });
  try {
    const desktop = await f.open();
    const run = await f.run(await desktop.submit(sessionId, input("verify-unknown")));
    const first = await desktop.next();
    if (first.type !== "execute") throw new Error("Expected the first Computer action");
    expect(first.action).toEqual({ type: "open_app", app: "Notepad" });
    expect((await desktop.dispatch(first.requestId)).ok).toBe(true);
    expect((await desktop.error(first.requestId, "unknown")).status).toBe(200);
    const observation = await desktop.next();
    if (observation.type !== "execute") throw new Error("Expected a Computer observation");
    expect(observation.action).toEqual({ type: "observe" });
    await desktop.result(observation.requestId, { status: "observed", text: "Current control state" });
    const next = await desktop.next();
    if (next.type !== "execute") throw new Error("Expected a Computer action after observation");
    expect(next.action).toEqual({ type: "open_app", app: "Paint" });
    await desktop.error(next.requestId, "not_started");
    expect(await f.awaitRun(run)).toMatchObject({ status: "completed" });
    const results = f.requests.at(-1)?.messages.filter(message => message.type === "tool_result");
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolUseId: "computer-1", executionState: "unknown" }),
      expect.objectContaining({ toolUseId: "computer-2", executionState: "not_started" }),
      expect.objectContaining({ toolUseId: "computer-4", executionState: "not_started" }),
    ]));
  } finally { await f.close(); }
}, 20_000);

it("orders Computer and Browser in the same batch and carries a read value into the next browser call", async () => {
  const execute = vi.fn<BrowserHost["execute"]>(async ({ action }) => ({
    url: action.action === "navigate" ? action.url : "https://example.test/",
    title: "Orders",
    pageText: action.action === "navigate" && action.url.endsWith("/order-38") ? "Order 38 verified" : "Order lookup",
  }));
  const f = await fixture("full_access", "observe", async function* (params, call) {
    if (call === 1) {
      yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "order-window", name: "Computer", input: { action: "observe" } } };
      yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "order-browser", name: "Browser", input: { action: "inspect" } } };
      yield { type: "complete", stopReason: "tool_use" };
    } else if (call === 2) {
      const window = params.messages.find(message => message.type === "tool_result" && message.toolUseId === "order-window");
      const order = /order-\d+/u.exec(JSON.stringify(window))?.[0];
      expect(order).toBe("order-38");
      yield { type: "tool_use_start", toolUse: { type: "tool_use", id: "order-result", name: "Browser", input: { action: "navigate", url: "https://example.test/" + order } } };
      yield { type: "complete", stopReason: "tool_use" };
    } else {
      yield { type: "complete", stopReason: "end_turn" };
    }
  }, { execute });
  try {
    const desktop = await f.open();
    const run = await f.run(await desktop.submit(sessionId, input("cross-host")));
    const computer = await desktop.next();
    if (computer.type !== "execute") throw new Error("Expected the Computer observation");
    expect(computer.action.type).toBe("observe");
    expect(execute).not.toHaveBeenCalled();
    await desktop.result(computer.requestId, { text: '{"status":"observed","observation":"order-38"}' });
    expect(await f.awaitRun(run)).toMatchObject({ status: "completed" });
    expect(execute.mock.calls.map(([input]) => input.action)).toEqual([
      { action: "inspect" }, { action: "navigate", url: "https://example.test/order-38" },
    ]);
    const readback = f.requests.at(-1)?.messages.find(message => message.type === "tool_result" && message.toolUseId === "order-result");
    expect(JSON.stringify(readback)).toContain("Order 38 verified");
  } finally { await f.close(); }
}, 20_000);

it("exposes the real Computer tool only to a newly admitted Desktop user run", async () => {
  const f = await fixture("full_access");
  try {
    const desktop = await f.open();
    expect((await desktop.submit(sessionId, { content: text })).status).toBe(400);
    const ordinaryInput = { ...input("ordinary"), metadata: { computer: true, computerConnectionId: "spoofed" } };
    const ordinary = await f.run(await f.post(`/sessions/${sessionId}/prompts`, ordinaryInput));
    expect(await f.awaitRun(ordinary)).toMatchObject({ status: "completed" });
    expect(f.requests.at(-1)?.tools?.map(tool => tool.name)).not.toContain("Computer");
    const duplicate = await f.run(await desktop.submit(sessionId, ordinaryInput));
    expect(duplicate).toEqual(ordinary);

    const trusted = await f.run(await desktop.submit(sessionId, input("trusted")));
    const dispatched = await desktop.next();
    if (dispatched.type !== "execute") throw new Error("Expected the Computer observation");
    expect(dispatched).toMatchObject({ run: trusted, action: { type: "observe" } });
    const retry = await f.run(await desktop.submit(sessionId, input("trusted")));
    expect(retry).toEqual(trusted);
    expect((await desktop.result(dispatched.requestId)).status).toBe(200);
    expect(await f.awaitRun(trusted)).toMatchObject({ status: "completed" });
    expect(await desktop.next()).toEqual({ type: "ended", run: trusted });
    const settled = f.requests.at(-1)?.messages.findLast(message => message.type === "tool_result");
    expect(settled).toMatchObject({
      content: expect.arrayContaining([{ type: "text", text: "Verified fake window" }]),
    });
    expect((await desktop.result(dispatched.requestId)).status).toBe(404);

    expect((await f.create("plan", { metadata: { runtime: { workMode: "plan" } } })).status).toBe(201);
    expect((await desktop.submit("plan", input("plan"))).status).toBe(409);
    expect((await f.create("channel")).status).toBe(201);
    f.server.store.channels.upsertConversation({ connector: "test", accountId: "test", chatId: "test", sessionId: "channel" });
    expect((await desktop.submit("channel", input("channel"))).status).toBe(409);
    f.server.store.sessions.create({ id: "delegated", model: "test-model", cwd: process.cwd(), parentId: sessionId });
    const delegated = await desktop.submit("delegated", input("delegated"));
    expect(delegated.status).toBe(409);
    expect(await delegated.json()).toMatchObject({ code: COMPUTER_SESSION_UNAVAILABLE });
    const forkResponse = await f.post(`/sessions/${sessionId}/fork`, { copyHistory: false });
    expect(forkResponse.status).toBe(201);
    const { session: fork } = await forkResponse.json() as { session: { id: string } };
    const unavailable = await desktop.submit(fork.id, input("fork"));
    expect(await unavailable.json()).toMatchObject({ code: COMPUTER_SESSION_UNAVAILABLE });
    const fallback = await f.run(await f.post(`/sessions/${fork.id}/prompts`, input("fork")));
    expect(await f.awaitRun(fallback)).toMatchObject({ status: "completed" });
    expect(f.requests.at(-1)?.tools?.map(tool => tool.name)).not.toContain("Computer");
    expect((await desktop.submit(sessionId, { ...input("steer"), delivery: "steer" })).status).toBe(409);
    expect((await f.create("denied", { metadata: { runtime: { disallowedTools: ["Computer"] } } })).status).toBe(201);
    const denied = await f.run(await desktop.submit("denied", input("denied")));
    expect(await f.awaitRun(denied)).toMatchObject({ status: "completed" });
    expect(await desktop.next()).toEqual({ type: "ended", run: denied });
    expect(f.requests.at(-1)?.tools?.map(tool => tool.name)).not.toContain("Computer");

    const inFlight = await f.run(await desktop.submit(sessionId, input("in-flight")));
    const pending = await desktop.next();
    if (pending.type !== "execute") throw new Error("Expected a pending Computer observation");
    expect(pending.run).toEqual(inFlight);
    await desktop.close();
    expect(await f.awaitRun(inFlight)).toMatchObject({ status: "completed" });
    const reopened = await f.open();
    expect((await desktop.result(pending.requestId)).status).toBe(404);
    expect((await reopened.result(pending.requestId)).status).toBe(404);
    expect(await f.run(await reopened.submit(sessionId, input("in-flight")))).toEqual(inFlight);
    expect(f.requests.at(-1)?.messages.findLast(message => message.type === "tool_result")).toMatchObject({
      isError: true, executionState: "not_started",
    });
  } finally {
    await f.close();
  }
}, 30_000);

it("lets Desktop handle app consent and still revokes interrupted or disconnected work", async () => {
  const f = await fixture("ask");
  try {
    const desktop = await f.open();
    const identity = await f.run(await desktop.submit(sessionId, input("pending")));
    expect(await desktop.next()).toMatchObject({ type: "execute", run: identity });
    expect(f.server.application.permissions.listRequests({ sessionId, toolName: "Computer" })).toEqual([]);
    await desktop.close();
    expect(await f.awaitRun(identity)).toMatchObject({ status: "completed" });
    const denied = f.requests.at(-1)?.messages.findLast(message => message.type === "tool_result");
    expect(denied).toMatchObject({ isError: true, executionState: "not_started" });

    const reopened = await f.open();
    const interrupted = await f.run(await reopened.submit(sessionId, input("interrupt")));
    expect(await reopened.next()).toMatchObject({ type: "execute", run: interrupted });
    expect((await f.post(`/sessions/${sessionId}/interrupt`, {})).ok).toBe(true);
    expect(await f.awaitRun(interrupted)).toMatchObject({ status: "interrupted" });
    const replay = await f.run(await f.post(`/sessions/${sessionId}/runs/${interrupted.runId}/resume`, { id: "replay" }));
    expect(replay.runId).not.toBe(interrupted.runId);
    expect(await f.awaitRun(replay)).toMatchObject({ status: "completed" });
    expect(f.requests.at(-1)?.tools?.map(tool => tool.name)).not.toContain("Computer");
  } finally {
    await f.close();
  }
}, 25_000);
