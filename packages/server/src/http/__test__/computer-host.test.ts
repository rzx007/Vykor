import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { get, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfiguredApprovalReviewer } from "@vykor/agent-runtime";
import type { Settings } from "@vykor/host-config";
import { CURRENT_PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from "@vykor/protocol";
import { SessionStore } from "@vykor/services";
import { expect, it, vi } from "vitest";
import { captureComputerApproval } from "../../application/computer-tools/computer-approval.js";
import { DesktopComputerBridge } from "../../application/computer-tools/computer-bridge.js";
import {
  COMPUTER_HOST_TOKEN_HEADER,
  parseComputerAction,
  parseComputerBridgeEvent,
  parseComputerReply,
} from "../../application/computer-tools/computer-bridge-protocol.js";
import { StorePermissionBroker } from "../../permissions/permission-broker.js";
import { createComputerHostRoutes } from "../routes/computer-host.js";
import { createPermissionRoutes } from "../routes/permission.js";
import { VykorHttpServer } from "../server.js";

vi.mock("@vykor/agent-runtime", async importOriginal => {
  const actual = await importOriginal<typeof import("@vykor/agent-runtime")>();
  return { ...actual, createConfiguredApprovalReviewer: vi.fn(actual.createConfiguredApprovalReviewer) };
});

const token = "a1".repeat(32);
const headers = {
  [PROTOCOL_VERSION_HEADER]: String(CURRENT_PROTOCOL_VERSION),
  authorization: "Bearer api-token",
};
const computerHeaders = { ...headers, [COMPUTER_HOST_TOKEN_HEADER]: token };
const run = { sessionId: "session", runId: "run", inputId: "input" };
const action = { type: "observe" } as const;

const frameRef = "frame_00000000-0000-4000-8000-000000000001";

it("accepts an explicit new-window request without shortcut overrides or an existing window hint", () => {
  const request = { type: "open_app", app: "Notepad", newWindow: true };
  expect(parseComputerAction(request)).toEqual(request);
  expect(parseComputerAction({ ...request, windowHint: "notes.txt" })).toBeUndefined();
  expect(parseComputerAction({ ...request, arguments: ["notes.txt"] })).toBeUndefined();
  expect(parseComputerAction({ ...request, newWindow: false })).toBeUndefined();
});

it("bounds foreground input and rejects unsupported wire shapes", () => {
  expect(parseComputerAction({ type: "handoff" })).toEqual({ type: "handoff" });
  expect(parseComputerAction({ type: "click", frameRef, x: 4, y: 30 })).toEqual({ type: "click", frameRef, x: 4, y: 30 });
  expect(parseComputerAction({ type: "click", frameRef, x: 4, y: 30, button: "right" })).toMatchObject({ button: "right" });
  const point = { frameRef, x: 4, y: 30 };
  const crop = { type: "capture", frameRef, region: { x: 10, y: 15, width: 20, height: 25 } };
  for (const action of [
    { type: "click", ...point, count: 2, modifiers: ["ctrl", "shift"] },
    { type: "drag", ...point, toX: 80, toY: 100 },
    { type: "scroll_at", ...point, direction: "left", amount: 4 },
    { type: "hover", ...point },
    crop,
  ]) expect(parseComputerAction(action)).toEqual(action);
  expect(parseComputerAction({ type: "key", key: "A", modifiers: ["ctrl", "shift"] })).toEqual({ type: "key", key: "A", modifiers: ["ctrl", "shift"] });
  for (const invalid of [
    { type: "capture", desktop: true }, { type: "handoff", message: "agent text" },
    { ...crop, purpose: "result" }, { ...crop, region: { ...crop.region, width: 2000 } },
    { type: "click", ...point, count: 2, button: "right" },
    { type: "click", ...point, modifiers: ["alt"] }, { type: "click", ...point, modifiers: ["ctrl", "ctrl"] },
    { type: "drag", ...point, toX: -1, toY: 31 }, { type: "drag", ...point, toX: point.x, toY: point.y },
    { type: "scroll_at", ...point, direction: "down", amount: 6 }, { type: "hover", ...point, toX: 9 },
    { type: "click", frameRef, x: -1, y: 30 }, { type: "click", frameRef, x: 4.5, y: 30 },
    { type: "click", frameRef, x: 4, y: 30, button: "middle" },
    { type: "click", frameRef: "latest", x: 4, y: 30 }, { type: "key", key: "a", modifiers: ["win"] },
    { type: "key", key: "a", modifiers: ["ctrl", "ctrl"] }, { type: "type_text", text: "unsafe\u0000" },
    { type: "type_text", text: "two\nlines" }, { type: "type_text", text: "a".repeat(1001) },
  ]) expect(parseComputerAction(invalid)).toBeUndefined();
});

it("rejects malformed, mismatched and oversized capture bytes", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHuoAAAAASUVORK5CYII=";
  const image = { mediaType: "image/png", data: png, width: 1, height: 1 };
  const reply = (capture: Record<string, unknown>) => ({ result: { text: "Captured", image: capture } });
  expect(parseComputerReply(reply(image))).toEqual(reply(image));
  for (const invalid of [
    { ...image, width: 2 }, { ...image, mediaType: "image/jpeg" }, { ...image, data: "a" },
    { ...image, data: "a".repeat(1_048_580) }, { ...image, name: "capture" },
  ]) expect(parseComputerReply(reply(invalid))).toBeUndefined();
});

function nativeGet(url: string, requestHeaders: Record<string, string>) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    get(url, { headers: { ...requestHeaders, connection: "close" } }, resolve).on("error", reject);
  });
}

it.each([["127.0.0.1", 200], ["0.0.0.0", 404]] as const)(
  "requires both native credentials and a loopback listener (%s)",
  async (host, authorizedStatus) => {
    const directory = await mkdtemp(join(tmpdir(), "vykor-computer-host-"));
    const server = new VykorHttpServer({
      storePath: join(directory, "sessions.db"),
      token: "api-token",
      desktopComputerToken: token,
      logger: () => {},
      allowedOrigins: ["http://localhost:3000"],
    });
    let stream: IncomingMessage | undefined;
    try {
      const { port } = await server.listen({ host });
      const url = `http://127.0.0.1:${port}/computer-host/stream`;
      const status = async (requestHeaders: Record<string, string>) => {
        const reply = await nativeGet(url, requestHeaders);
        reply.resume();
        return reply.statusCode;
      };
      if (host === "127.0.0.1") {
        expect(await status({ ...headers })).toBe(401);
        expect(await status({ ...computerHeaders, authorization: "Bearer unrelated" })).toBe(401);
        expect(await status({ ...computerHeaders, [COMPUTER_HOST_TOKEN_HEADER]: "0".repeat(64) })).toBe(401);
        expect(await status({ ...computerHeaders, origin: "http://localhost:3000" })).toBe(403);
        expect(await status({ ...computerHeaders, "sec-fetch-site": "same-origin" })).toBe(403);
      }
      stream = await nativeGet(url, computerHeaders);
      expect(stream.statusCode).toBe(authorizedStatus);
      if (authorizedStatus === 200) {
        expect(String((await once(stream, "data"))[0])).toContain('"type":"connected"');
        expect(await status(computerHeaders)).toBe(409);
        const disconnected = once(stream, "close");
        stream.destroy();
        await disconnected;
        await vi.waitFor(async () => {
          const probe = await nativeGet(url, computerHeaders);
          const code = probe.statusCode;
          probe.destroy();
          expect(code).toBe(200);
        });
      }
    } finally {
      stream?.destroy();
      await server.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000,
);

function fixture(bridge = new DesktopComputerBridge()) {
  const submit = vi.fn(async (_connectionId: string, _sessionId: string, _input: Record<string, unknown>) =>
    new Response(JSON.stringify({ accepted: true }), { status: 202 }));
  const app = createComputerHostRoutes({ bridge, token, available: () => true, submit });
  const post = (path: string, body: unknown, requestHeaders = computerHeaders) => app.request(path, {
    method: "POST",
    headers: { ...requestHeaders, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const stream = async () => {
    const response = await app.request("/stream", { headers: computerHeaders });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const next = async () => {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Computer bridge closed");
      return parseComputerBridgeEvent(JSON.parse(new TextDecoder().decode(chunk.value).slice(6).trim()));
    };
    const connected = await next();
    if (connected.type !== "connected") throw new Error("Computer connection expected");
    return { ...connected, next, close: () => reader.cancel() };
  };
  return { bridge, post, stream, submit };
}

it("explicitly reports a stale private submission before accepting any prompt", async () => {
  const { post, submit } = fixture();
  const response = await post("/stale-connection/submit", { sessionId: "session", input: { content: "hello" } });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "computer_session_unavailable" });
  expect(submit).not.toHaveBeenCalled();
});

it("binds submissions and results to the active connection and settles a command once", async () => {
  const { bridge, stream, post, submit } = fixture();
  const connection = await stream();
  const { connectionId } = connection;
  const input = { items: [{ type: "text", text: "Observe" }] };
  try {
    expect((await post("/old/submit", { sessionId: "session", input })).status).toBe(409);
    expect((await post(`/${connectionId}/submit`, { sessionId: "session", input }, headers)).status).toBe(401);
    expect(submit).not.toHaveBeenCalled();
    expect((await post(`/${connectionId}/submit`, { sessionId: "session", input })).status).toBe(202);
    expect(submit).toHaveBeenCalledWith(connectionId, "session", input, expect.any(Request));
    const pending = bridge.execute(connectionId, run, action);
    await expect(bridge.execute(connectionId, run, action)).rejects.toMatchObject({ executionState: "not_started" });
    const command = await connection.next();
    if (command.type !== "execute") throw new Error("Computer command expected");
    expect(command).toMatchObject({ run, action });
    const route = (id: string) => `/${id}/${command.requestId}/result`;
    expect((await post(route("old"), { result: { text: "Wrong" } })).status).toBe(404);
    expect((await post(route(connectionId), { result: { private: 123 } })).status).toBe(400);
    expect((await post(route(connectionId), { result: { text: "Observed" } })).status).toBe(200);
    await expect(pending).resolves.toEqual({ text: "Observed" });
    expect((await post(route(connectionId), { result: { text: "Repeated" } })).status).toBe(404);
  } finally {
    await connection.close();
  }
});

it("aborts old work on disconnect and a replacement receives only fresh commands", async () => {
  const { bridge, stream, post } = fixture();
  const first = await stream();
  const signal = bridge.connectionSignal(first.connectionId)!;
  const pending = expect(bridge.execute(first.connectionId, run, action))
    .rejects.toMatchObject({ executionState: "not_started" });
  const command = await first.next();
  if (command.type !== "execute") throw new Error("Computer command expected");
  await first.close();
  await pending;
  expect(signal.aborted).toBe(true);
  const second = await stream();
  try {
    expect(second.connectionId).not.toBe(first.connectionId);
    expect(bridge.connectionSignal(first.connectionId)).toBeUndefined();
    await expect(bridge.execute(first.connectionId, run, action)).rejects.toMatchObject({ executionState: "not_started" });
    expect((await post(`/${first.connectionId}/${command.requestId}/result`, { result: { text: "Late" } })).status).toBe(404);
    const cancellation = new AbortController();
    const current = expect(bridge.execute(second.connectionId, run, action, { signal: cancellation.signal }))
      .rejects.toMatchObject({ executionState: "not_started" });
    const dispatched = await second.next();
    if (dispatched.type !== "execute") throw new Error("Computer command expected");
    expect(dispatched.requestId).not.toBe(command.requestId);
    cancellation.abort();
    expect(await second.next()).toEqual({ type: "cancel", requestId: dispatched.requestId });
    await current;
  } finally {
    await second.close();
  }
});

it("revokes a screenshot already returned to the model queue", async () => {
  const { bridge, stream, post } = fixture();
  const connection = await stream();
  try {
    const pending = bridge.execute(connection.connectionId, run, { type: "capture" });
    const command = await connection.next();
    if (command.type !== "execute") throw new Error("Computer command expected");
    const path = `/${connection.connectionId}/${command.requestId}`;
    const image = { mediaType: "image/png", width: 1, height: 1,
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHuoAAAAASUVORK5CYII=" };
    expect((await post(path + "/result", { result: { text: "Capture", image } })).status).toBe(200);
    const capture = await pending;
    expect(capture.image).toEqual(image);
    expect(capture.isImageCurrent?.()).toBe(true);
    expect((await post(path + "/revoke-image", {})).status).toBe(200);
    expect(capture.isImageCurrent?.()).toBe(false);
  } finally { await connection.close(); }
});

it("rejects oversized uploads without implying an undispatched action changed the app", async () => {
  const { bridge, stream, post, submit } = fixture();
  const connection = await stream();
  const { connectionId } = connection;
  const oversized = "x".repeat(2 * 1024 * 1024);
  try {
    expect((await post(`/${connectionId}/submit`, { sessionId: "session", input: { content: "x".repeat(512 * 1024) } })).status).toBe(202);
    expect((await post(`/${connectionId}/submit`, { sessionId: "session", input: { content: oversized } })).status).toBe(413);
    expect(submit).toHaveBeenCalledOnce();
    const pending = expect(bridge.execute(connectionId, run, action)).rejects.toMatchObject({ executionState: "not_started" });
    const command = await connection.next();
    if (command.type !== "execute") throw new Error("Computer command expected");
    const response = await post(`/${connectionId}/${command.requestId}/result`, { result: { text: oversized } });
    expect(response.status).toBe(413);
    expect(response.headers.get("connection")).toBe("close");
    await pending;
  } finally {
    await connection.close();
  }
});

it("drops a queued command when the stream closes before Desktop reads it", async () => {
  const { bridge, stream } = fixture();
  const connection = await stream();
  const pending = expect(bridge.execute(connection.connectionId, run, action))
    .rejects.toMatchObject({ executionState: "not_started" });
  bridge.detach(connection.connectionId);
  await pending;
  await expect(connection.next()).rejects.toThrow("Computer bridge closed");
});

async function approvalFixture(
  approvalMode: "ask" | "auto_review" | "full_access" | null = "ask",
  resolveSettings?: () => Promise<Settings>,
) {
  const directory = await mkdtemp(join(tmpdir(), "vykor-computer-approval-"));
  const store = new SessionStore({ path: join(directory, "sessions.db") });
  store.sessions.create({
    id: run.sessionId, cwd: directory, model: "offline",
    metadata: { runtime: { model: "offline", ...(approvalMode ? { approvalMode } : {}) } },
  });
  store.conversationTransactions.admitPrompt({ id: run.inputId, sessionId: run.sessionId, content: "Change a Windows setting." });
  store.runs.createRun({ id: run.runId, sessionId: run.sessionId, inputId: run.inputId });
  store.runs.updateRun(run.runId, { status: "running" });
  const broker = new StorePermissionBroker({
    permissions: store.permissions,
    getSession: id => store.sessions.get(id),
    latestEventSeq: () => store.conversations.latestEventSeq(),
  });
  const bridge = new DesktopComputerBridge(scope => captureComputerApproval(store, broker, scope, resolveSettings));
  const { post, stream } = fixture(bridge);
  const connection = await stream();
  const { connectionId } = connection;
  const start = async (action: Parameters<typeof bridge.execute>[2], signal?: AbortSignal) => {
    const execution = bridge.execute(connectionId, run, action, { signal })
      .then(result => ({ result }), error => ({ error: error as Error }));
    const event = await connection.next();
    if (event.type !== "execute") throw new Error("Computer command expected");
    const requestUrl = `/${connectionId}/${event.requestId}`;
    return { execution, requestUrl, event };
  };
  const propose = async (signal?: AbortSignal, action: Parameters<typeof bridge.execute>[2] = {
    type: "invoke", elementRef: "element_00000000-0000-4000-8000-000000000001",
  }) => {
    const { execution, requestUrl } = await start(action, signal);
    const proposal = {
      proposalId: "00000000-0000-4000-8000-000000000001", reason: "Change the selected Windows setting.",
    };
    const decision = post(requestUrl + "/approval", proposal);
    await vi.waitFor(() => expect(broker.listRequests({ status: "pending" })).toHaveLength(1));
    const [approval] = broker.listRequests({ status: "pending" });
    const reply = { requestId: approval!.id, sessionId: run.sessionId, status: "approved" };
    const replyUrl = `/${connectionId}/approval-reply`;
    return { requestUrl, decision, execution, proposal, approval, reply, replyUrl };
  };
  return {
    close: async () => { await connection.close(); store.close(); await rm(directory, { recursive: true, force: true }); },
    disconnect: connection.close, post, broker, store, propose, start, bridge, connectionId,
  };
}

it("uses full access for semantic operations, foreground entry and coordinate clicks", async () => {
  const { close, post, start, broker } = await approvalFixture("full_access");
  const invoke = { type: "invoke", elementRef: "element_00000000-0000-4000-8000-000000000001" } as const;
  try {
    for (const action of [invoke, { type: "foreground" }, { type: "click", frameRef, x: 4, y: 30 }] as const) {
      const call = await start(action);
      expect(call.event.fullAccess).toBe(true);
      expect((await post(call.requestUrl + "/result", { result: { text: "Done" } })).status).toBe(404);
      expect((await post(call.requestUrl + "/dispatch", {})).status).toBe(200);
      expect((await post(call.requestUrl + "/result", { result: { text: "Done" } })).status).toBe(200);
      await expect(call.execution).resolves.toMatchObject({ result: { text: "Done" } });
    }
    expect(broker.listRequests()).toHaveLength(0);
  } finally { await close(); }
});

it("still requests one-time approval for control actions in ask mode", async () => {
  const { close, post, propose } = await approvalFixture();
  try {
    const call = await propose();
    expect(call.approval).toMatchObject({ status: "pending", payload: { approvalMode: "ask" } });
    await post(call.replyUrl, { ...call.reply, status: "denied" });
    expect(await (await call.decision).json()).toMatchObject({ approved: false });
    await post(call.requestUrl + "/result", { error: "Declined", executionState: "not_started" });
    await call.execution;
  } finally { await close(); }
});

it("uses the shared automatic review and falls back to the original Desktop chat when evidence is unavailable", async () => {
  const { close, post, propose, broker } = await approvalFixture("auto_review");
  try {
    const call = await propose(undefined, { type: "foreground" });
    await vi.waitFor(() => expect(broker.getRequest(call.approval!.id)).toMatchObject({
      status: "pending", payload: { approvalMode: "auto_review", approvalReview: { status: "ask_user" } },
    }));
    expect((await post(call.requestUrl + "/dispatch", {})).status).toBe(404);
    expect((await post(call.replyUrl, call.reply)).status).toBe(200);
    expect(await (await call.decision).json()).toMatchObject({ approved: true });
    expect((await post(call.requestUrl + "/dispatch", {})).status).toBe(200);
    await post(call.requestUrl + "/result", { result: { text: "Controlled" } });
    await expect(call.execution).resolves.toMatchObject({ result: { text: "Controlled" } });
  } finally { await close(); }
});

it("gives the standard reviewer the exact unisolated operation and accepts its decision", async () => {
  const { close, post, start, store, broker } = await approvalFixture("auto_review", async () => ({
    model: "offline", apiFormat: "openai", maxTurns: 5, permission: { mode: "auto_review" }, sandbox: { enabled: true },
  }));
  const review = vi.fn(async () => ({ decision: "approve", risk: "low", authorization: "explicit", reason: "Reviewed" } as const));
  vi.mocked(createConfiguredApprovalReviewer).mockResolvedValueOnce({ review });
  try {
    store.runs.updateRun(run.runId, { metadata: { appliedInputState: { revision: 1, inputIds: [run.inputId] } } });
    const call = await start({ type: "type_text", text: "Exact operation text" });
    const proposal = { proposalId: "00000000-0000-4000-8000-000000000001", reason: "Type in the current Windows editor." };
    expect(await (await post(call.requestUrl + "/approval", proposal)).json()).toMatchObject({ approved: true });
    expect(review).toHaveBeenCalledWith(expect.objectContaining({
      input: { action: "type_text", text: "Exact operation text" },
      evidence: expect.objectContaining({ reliableIsolation: false, userInstruction: "Change a Windows setting." }),
    }), expect.any(AbortSignal));
    expect(broker.listRequests()).toMatchObject([{ status: "approved", decision: "once" }]);
    expect((await post(call.requestUrl + "/dispatch", {})).status).toBe(200);
    await post(call.requestUrl + "/result", { result: { text: "Typed" } });
    await call.execution;
  } finally { await close(); }
});

it("inherits the daemon default and rechecks the run after loading it", async () => {
  const settings: Settings = { model: "offline", apiFormat: "openai", maxTurns: 5, permission: { mode: "full_access" } };
  const resolveSettings = vi.fn(async () => settings);
  const { close, post, start, broker, store, bridge, connectionId } = await approvalFixture(null, resolveSettings);
  const invoke = { type: "invoke", elementRef: "element_00000000-0000-4000-8000-000000000001" } as const;
  try {
    const button = await start(invoke);
    expect(resolveSettings).toHaveBeenCalledOnce();
    expect(button.event.fullAccess).toBe(true);
    expect((await post(button.requestUrl + "/dispatch", {})).status).toBe(200);
    await post(button.requestUrl + "/result", { result: { text: "Pressed" } });
    await button.execution;

    const reading = Promise.withResolvers<void>();
    const setting = Promise.withResolvers<Settings>();
    resolveSettings.mockImplementationOnce(() => {
      reading.resolve();
      return setting.promise;
    });
    const stale = expect(bridge.execute(connectionId, run, invoke)).rejects.toMatchObject({ executionState: "not_started" });
    await reading.promise;
    store.runs.updateRun(run.runId, { status: "interrupted" });
    setting.resolve(settings);
    await stale;
    expect(broker.listRequests({ status: "pending" })).toHaveLength(0);
  } finally { await close(); }
});

it("requires once-approved foreground entry and input, each with one fresh private dispatch", async () => {
  const { post, close, propose } = await approvalFixture();
  try {
    const entry = await propose(undefined, { type: "foreground" });
    expect((await post(entry.requestUrl + "/dispatch", {})).status).toBe(404);
    expect((await post(entry.replyUrl, entry.reply)).status).toBe(200);
    expect((await (await entry.decision).json()).approved).toBe(true);
    expect((await post(entry.requestUrl + "/result", { result: { text: "Started" } })).status).toBe(404);
    expect((await post(entry.requestUrl + "/dispatch", {}, headers)).status).toBe(401);
    expect((await post(entry.requestUrl + "/dispatch", { pretend: true })).status).toBe(400);
    expect(await (await post(entry.requestUrl + "/dispatch", {})).json()).toEqual({ authorized: true });
    expect((await post(entry.requestUrl + "/dispatch", {})).status).toBe(404);
    expect((await post(entry.requestUrl + "/result", { result: { text: "Started" } })).status).toBe(200);
    await expect(entry.execution).resolves.toMatchObject({ result: { text: "Started" } });

    const click = await propose(undefined, { type: "click", frameRef, x: 4, y: 30 });
    expect((await post(click.requestUrl + "/dispatch", {})).status).toBe(404);
    expect((await post(click.replyUrl, click.reply)).status).toBe(200);
    expect(await (await click.decision).json()).toMatchObject({ approved: true });
    expect((await post(click.requestUrl + "/dispatch", {})).status).toBe(200);
    expect((await post(click.requestUrl + "/result", { result: { text: "Clicked" } })).status).toBe(200);
    await expect(click.execution).resolves.toMatchObject({ result: { text: "Clicked" } });
  } finally { await close(); }
});

it.each([{ type: "open_app", app: "Notepad" }, {
  type: "set_text", elementRef: "element_00000000-0000-4000-8000-000000000001", text: "Note",
}] as const)("requires current dispatch authorization for $type", async action => {
  const { post, close, start, store } = await approvalFixture("full_access");
  try {
    const call = await start(action);
    expect((await post(call.requestUrl + "/result", { result: { text: "Done" } })).status).toBe(404);
    expect((await post(call.requestUrl + "/dispatch", {})).status).toBe(200);
    expect((await post(call.requestUrl + "/result", { result: { text: "Done" } })).status).toBe(200);
    await expect(call.execution).resolves.toMatchObject({ result: { text: "Done" } });

    const stale = await start(action);
    store.runs.updateRun(run.runId, { status: "interrupted" });
    expect((await post(stale.requestUrl + "/dispatch", {})).status).toBe(404);
    expect((await post(stale.requestUrl + "/result", { error: "Stale", executionState: "not_started" })).status).toBe(200);
    await expect(stale.execution).resolves.toMatchObject({ error: { executionState: "not_started" } });
  } finally { await close(); }
});

it("blocks dispatch when input changes after a private approval has already arrived", async () => {
  const { post, close, propose, store } = await approvalFixture();
  try {
    const call = await propose(undefined, { type: "foreground" });
    expect((await post(call.replyUrl, call.reply)).status).toBe(200);
    expect((await (await call.decision).json()).approved).toBe(true);
    store.runs.updateRun(run.runId, { metadata: { appliedInputState: { revision: 2, inputIds: [run.inputId, "new-input"] } } });
    expect((await post(call.requestUrl + "/dispatch", {})).status).toBe(404);
    expect((await post(call.requestUrl + "/result", { error: "Stale", executionState: "not_started" })).status).toBe(200);
    await expect(call.execution).resolves.toMatchObject({ error: { executionState: "not_started" } });
  } finally { await close(); }
});

it("refuses a full-access dispatch after the session switches to ask without a runtime revision change", async () => {
  const { post, close, start, store } = await approvalFixture("full_access");
  try {
    const call = await start({ type: "foreground" });
    expect(call.event.fullAccess).toBe(true);
    store.sessions.update(run.sessionId, { metadata: { runtime: { model: "offline", approvalMode: "ask" } } });
    expect((await post(call.requestUrl + "/dispatch", {})).status).toBe(404);
    await post(call.requestUrl + "/result", { error: "Mode changed", executionState: "not_started" });
    await expect(call.execution).resolves.toMatchObject({ error: { executionState: "not_started" } });
  } finally { await close(); }
});

it("requires one private reply in the owning session and refuses success before approval", async () => {
  const { post, broker, close, propose } = await approvalFixture();
  try {
    const { requestUrl, decision, execution, proposal, approval, reply, replyUrl } = await propose();
    expect(approval).toMatchObject({ runId: run.runId, sessionId: run.sessionId, status: "pending", payload: { computerApproval: true } });
    const normal = createPermissionRoutes({ permissions: broker, traces: { get: () => undefined } });
    expect((await normal.request(`/${reply.requestId}/reply`, {
      method: "POST", body: JSON.stringify({ status: "approved", decision: "session" }),
    })).status).toBe(409);
    expect((await post(replyUrl, { ...reply, sessionId: "wrong" })).status).toBe(404);
    expect((await post(replyUrl, reply, headers)).status).toBe(401);
    expect((await post(replyUrl, reply, { ...computerHeaders, origin: "http://localhost" })).status).toBe(403);
    expect((await post(requestUrl + "/approval", proposal)).status).toBe(404);
    expect((await post(requestUrl + "/result", { result: { text: "Premature" } })).status).toBe(404);
    const approved = await post(replyUrl, reply);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ request: { status: "approved", decision: "once" } });
    expect(await (await decision).json()).toEqual({ approved: true, proposalId: proposal.proposalId });
    expect((await post(replyUrl, reply)).status).toBe(404);
    expect((await post(requestUrl + "/dispatch", {})).status).toBe(200);
    expect((await post(requestUrl + "/result", { result: { text: "Verified" } })).status).toBe(200);
    await expect(execution).resolves.toEqual({ result: { text: "Verified" } });
  } finally { await close(); }
});

it("expires protected approval when the run input revision changes", async () => {
  const { post, close, propose, store } = await approvalFixture();
  try {
    const { requestUrl, decision, execution, reply, replyUrl } = await propose();
    store.runs.updateRun(run.runId, { metadata: { appliedInputState: { revision: 2, inputIds: [run.inputId, "new-input"] } } });
    const response = await post(replyUrl, reply);
    expect(await response.json()).toMatchObject({ request: { status: "expired" } });
    expect(await (await decision).json()).toMatchObject({ approved: false });
    expect((await post(requestUrl + "/result", { error: "Stale", executionState: "not_started" })).status).toBe(200);
    await expect(execution).resolves.toMatchObject({ error: { executionState: "not_started" } });
  } finally { await close(); }
});

it("expires protected approval on Stop and rejects the late human reply", async () => {
  const { post, close, propose, store } = await approvalFixture();
  try {
    const stop = new AbortController();
    const { decision, execution, reply, replyUrl } = await propose(stop.signal);
    stop.abort();
    expect(await (await decision).json()).toMatchObject({ approved: false });
    expect(store.permissions.get(reply.requestId)).toMatchObject({ status: "expired" });
    expect((await post(replyUrl, reply)).status).toBe(404);
    await expect(execution).resolves.toMatchObject({ error: { executionState: "not_started" } });
  } finally { await close(); }
});

it("expires an unanswered approval when Desktop disconnects", async () => {
  const { post, close, disconnect, propose, store } = await approvalFixture();
  try {
    const { decision, execution, reply, replyUrl } = await propose();
    await disconnect();
    expect(await (await decision).json()).toMatchObject({ approved: false });
    expect(store.permissions.get(reply.requestId)).toMatchObject({ status: "expired" });
    expect((await post(replyUrl, reply)).status).toBe(404);
    await expect(execution).resolves.toMatchObject({ error: { executionState: "not_started" } });
  } finally { await close(); }
});
