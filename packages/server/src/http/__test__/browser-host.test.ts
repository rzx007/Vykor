import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { get, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_PROTOCOL_VERSION, PROTOCOL_VERSION_HEADER } from "@vykor/protocol";
import { expect, it, vi } from "vitest";
import { BROWSER_BRIDGE_MAX_RESULT_BODY_BYTES, DesktopBrowserBridge } from "../../application/browser-tools/browser-bridge.js";
import { parseBrowserBridgeEvent } from "../../application/browser-tools/browser-bridge-protocol.js";
import { createBrowserTool } from "../../application/browser-tools/browser-tool.js";
import { createBrowserDeveloperTool } from "../../application/browser-tools/browser-developer-tool.js";
import { createBrowserHostRoutes } from "../routes/browser-host.js";
import { VykorHttpServer } from "../server.js";

const headers = { [PROTOCOL_VERSION_HEADER]: String(CURRENT_PROTOCOL_VERSION), connection: "close" };
const authorization = "Bearer desktop-token";

function openNative(url: string) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    get(url, { headers: { ...headers, authorization } }, resolve).on("error", reject);
  });
}

it("opens only a native authenticated browser host stream on a managed loopback listener", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vykor-browser-host-"));
  const server = new VykorHttpServer({
    storePath: join(directory, "sessions.db"),
    logger: () => {},
    token: "desktop-token",
    allowedOrigins: ["http://localhost:3000"],
    enableDesktopBrowser: true,
  });
  let stream: IncomingMessage | undefined;
  try {
    const { url } = await server.listen();
    const capabilities = await (await fetch(`${url}/capabilities`, { headers })).json();
    expect(capabilities.features.browserBridge).toBe(1);
    const endpoint = `${url}/browser-host/stream`;
    expect((await fetch(endpoint, { headers })).status).toBe(401);
    expect((await fetch(endpoint, {
      headers: { ...headers, authorization, origin: "http://localhost:3000" },
    })).status).toBe(403);
    expect((await fetch(endpoint, {
      headers: { ...headers, authorization, "sec-fetch-site": "same-origin" },
    })).status).toBe(403);
    expect((await fetch(endpoint, {
      headers: { ...headers, authorization },
    })).status).toBe(403);
    stream = await openNative(endpoint);
    expect(stream.statusCode).toBe(200);
    expect(String((await once(stream, "data"))[0])).toContain('"type":"hello"');
    const second = await openNative(endpoint);
    second.resume();
    expect(second.statusCode).toBe(409);
    await server.close();
  } finally {
    stream?.destroy();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function nextEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const chunk = await reader.read();
  return parseBrowserBridgeEvent(JSON.parse(new TextDecoder().decode(chunk.value).slice(6).trim()));
}

it("returns approvals to the desktop and consumes a result only once for that connection", async () => {
  const bridge = new DesktopBrowserBridge();
  const app = createBrowserHostRoutes(bridge, () => true);
  const reader = (await app.request("/stream")).body!.getReader();
  try {
    const hello = await nextEvent(reader);
    if (hello.type !== "hello") throw new Error("Expected browser hello");
    const permission = vi.fn(async () => ({ status: "approved" as const }));
    const tool = createBrowserDeveloperTool(bridge);
    const running = tool.execute({ action: "inspect_dom" }, { cwd: ".", sessionId: "test-session", requestPermission: permission });
    const command = await nextEvent(reader);
    if (command.type !== "command") throw new Error("Expected browser command");
    expect(command).toMatchObject({ kind: "developer", sessionId: "test-session", action: { action: "inspect_dom" } });
    const post = (connectionId: string, target: string, body: object) => app.request(`/${connectionId}/${command.requestId}/${target}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const approval = { kind: "origin", reason: "Allow example.test?" };
    expect((await post("old-connection", "approval", approval)).status).toBe(404);
    expect(permission).not.toHaveBeenCalled();
    expect(await (await post(hello.connectionId, "approval", approval)).json()).toEqual({ approved: true });
    expect(await (await post(hello.connectionId, "approval", { kind: "developer", reason: "Inspect DOM?" })).json()).toEqual({ approved: true });
    expect(permission.mock.calls).toEqual([
      [expect.objectContaining({ toolName: "Browser" }), { signal: expect.any(AbortSignal) }],
      [expect.objectContaining({ toolName: "BrowserDeveloper" }), { signal: expect.any(AbortSignal) }],
    ]);
    const result = { result: { action: "inspect_dom", url: "https://example.test", data: { tag: "main" } } };
    expect((await post(hello.connectionId, "result", result)).status).toBe(200);
    expect((await post(hello.connectionId, "result", result)).status).toBe(404);
    expect(await running).toEqual({ content: [{ type: "text", text: JSON.stringify(result.result) }] });
  } finally {
    await reader.cancel();
  }
});

it("classifies dispatched operations as unknown on disconnect and does not replay them", async () => {
  const bridge = new DesktopBrowserBridge();
  const app = createBrowserHostRoutes(bridge, () => true);
  const reader = (await app.request("/stream")).body!.getReader();
  expect(await nextEvent(reader)).toMatchObject({ type: "hello" });
  const tool = createBrowserTool(bridge, async () => "unused.png", async () => ({}));
  const input = { action: "click", elementId: "control" };
  const context = { cwd: ".", sessionId: "session", requestPermission: async () => ({ status: "approved" as const }) };
  const running = tool.execute(input, context);
  expect(await nextEvent(reader)).toMatchObject({ type: "command", kind: "browser", action: input });
  await reader.cancel();
  expect(await running).toMatchObject({ isError: true, executionState: "unknown", failureKind: "unknown_outcome" });
  expect(await tool.execute(input, context)).toMatchObject({ isError: true, executionState: "not_started" });
  const reconnect = (await app.request("/stream", { headers: { "last-event-id": "old-command" } })).body!.getReader();
  expect(await nextEvent(reconnect)).toMatchObject({ type: "hello" });
  const next = tool.execute({ action: "inspect" }, context);
  expect(await nextEvent(reconnect)).toMatchObject({ type: "command", action: { action: "inspect" } });
  await reconnect.cancel();
  expect(await next).toMatchObject({ executionState: "unknown" });
});

it("cancels a waiting approval on disconnect", async () => {
  const bridge = new DesktopBrowserBridge();
  const app = createBrowserHostRoutes(bridge, () => true);
  const reader = (await app.request("/stream")).body!.getReader();
  const hello = await nextEvent(reader);
  if (hello.type !== "hello") throw new Error("Expected browser hello");
  let started!: () => void;
  const approvalStarted = new Promise<void>((resolve) => { started = resolve; });
  const executing = bridge.execute({ action: { action: "inspect" }, includeScreenshot: false, sessionId: "session", cwd: ".",
    approve: (_reason, signal) => new Promise((_, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      started();
    }),
  });
  const rejection = expect(executing).rejects.toMatchObject({ executionState: "unknown" });
  const command = await nextEvent(reader);
  if (command.type !== "command") throw new Error("Expected browser command");
  const approving = app.request(`/${hello.connectionId}/${command.requestId}/approval`, {
    method: "POST", body: JSON.stringify({ kind: "origin", reason: "Allow example.test?" }),
  });
  await approvalStarted;
  await reader.cancel();
  await rejection;
  expect((await approving).status).toBe(404);
});

it("rejects a streamed approval body as soon as it exceeds its limit", async () => {
  const app = createBrowserHostRoutes(new DesktopBrowserBridge(), () => true);
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(32 * 1024 + 1)); }, cancel,
  });
  const request = { method: "POST", body, duplex: "half" };
  expect((await app.request("/connection/request/approval", request)).status).toBe(413);
  expect(cancel).toHaveBeenCalled();
});

it("fails only the pending command whose result exceeds the body limit", async () => {
  const bridge = new DesktopBrowserBridge();
  const app = createBrowserHostRoutes(bridge, () => true);
  const reader = (await app.request("/stream")).body!.getReader();
  try {
    const hello = await nextEvent(reader);
    if (hello.type !== "hello") throw new Error("Expected browser hello");
    const input = { action: { action: "inspect" as const }, includeScreenshot: false,
      sessionId: "session", cwd: ".", approve: async () => true };
    const outcomes = Promise.allSettled([bridge.execute(input), bridge.execute(input)]);
    const first = await nextEvent(reader);
    const second = await nextEvent(reader);
    if (first.type !== "command" || second.type !== "command") throw new Error("Expected browser commands");
    const resultPath = (requestId: string) => `/${hello.connectionId}/${requestId}/result`;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(BROWSER_BRIDGE_MAX_RESULT_BODY_BYTES + 1)); },
    });
    const request = { method: "POST", body: oversized, duplex: "half" };
    const response = await app.request(resultPath(first.requestId), request);
    expect(response.status).toBe(413);
    expect(response.headers.get("connection")).toBe("close");

    const result = { url: "https://example.test", title: "Fixture", pageText: "" };
    const postResult = (requestId: string) => app.request(resultPath(requestId), {
      method: "POST", body: JSON.stringify({ result }),
    });
    expect((await postResult(first.requestId)).status).toBe(404);
    expect((await postResult(second.requestId)).status).toBe(200);
    expect(await outcomes).toEqual([
      { status: "rejected", reason: new Error("The browser result was too large to return. The operation may already have run.") },
      { status: "fulfilled", value: result },
    ]);
    expect(bridge.connected).toBe(true);
  } finally {
    await reader.cancel();
  }
});

it("decodes screenshot bytes only for an authorized screenshot request", async () => {
  const bridge = new DesktopBrowserBridge();
  const app = createBrowserHostRoutes(bridge, () => true);
  const reader = (await app.request("/stream")).body!.getReader();
  try {
    const hello = await nextEvent(reader);
    if (hello.type !== "hello") throw new Error("Expected browser hello");
    const executing = bridge.execute({ action: { action: "inspect" }, includeScreenshot: true, sessionId: "session", cwd: ".",
      approve: async () => true,
    });
    const command = await nextEvent(reader);
    if (command.type !== "command") throw new Error("Expected browser command");
    const path = `/${hello.connectionId}/${command.requestId}/result`;
    const observation = { url: "https://example.test", title: "Fixture", pageText: "" };
    const post = (screenshotBase64: string) => app.request(path, { method: "POST",
      body: JSON.stringify({ result: observation, screenshotBase64 }),
    });
    expect((await post(Buffer.from("not a PNG").toString("base64"))).status).toBe(400);
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQ1sAAAAASUVORK5CYII=";
    expect((await post(png)).status).toBe(200);
    expect(await executing).toMatchObject({ ...observation, screenshotBytes: Buffer.from(png, "base64") });
  } finally {
    await reader.cancel();
  }
});
