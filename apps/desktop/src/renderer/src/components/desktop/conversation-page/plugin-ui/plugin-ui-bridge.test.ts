import { MessageChannel } from "node:worker_threads"
import { afterEach, expect, it, vi } from "vitest"
import { createPluginUiBridge } from "./plugin-ui-bridge"
import { mountId, snapshot } from "./plugin-ui-fixtures.test-support"
const cleanup: Array<() => void> = []
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn())
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
function fixture() {
  vi.stubGlobal("MessageChannel", MessageChannel)
  const host = new EventTarget()
  let port: import("node:worker_threads").MessagePort | undefined
  const received: any[] = []
  const child = {
    postMessage: vi.fn((_data, _origin, ports) => {
      port = ports[0]
      port!.on("message", (data) => received.push(JSON.parse(data)))
    }),
  }
  const handlers = {
    getSnapshot: vi.fn(async (_params: Record<string, unknown>, _signal: AbortSignal) => snapshot),
    requestAction: vi.fn(
      async (_params: Record<string, unknown>, _signal: AbortSignal): Promise<null> => null
    ),
    requestConversation: vi.fn(async () => null),
    resize: vi.fn(async () => null),
    dismiss: vi.fn(async () => null),
  }
  const onError = vi.fn()
  let visible = true
  const bridge = createPluginUiBridge({
    iframe: { contentWindow: child, ownerDocument: { defaultView: host } } as never,
    mountId,
    snapshot,
    isActive: () => true,
    isInteractive: () => visible,
    handlers,
    onError,
  })
  cleanup.push(() => {
    bridge.dispose()
    port?.close()
  })
  const ready = (source: unknown = child) =>
    host.dispatchEvent(
      Object.assign(new Event("message"), {
        source,
        data: { version: 2, type: "plugin-ui-ready" },
      })
    )
  let serial = 0
  const send = (method = "getSnapshot", params = {}, extra = {}) =>
    port!.postMessage(
      JSON.stringify({
        version: 2,
        mountId,
        id: String(++serial),
        method,
        params,
        ...extra,
      })
    )
  return {
    bridge,
    ready,
    child,
    handlers,
    received,
    send,
    onError,
    hide: () => { visible = false; bridge.setVisible(false) },
    get port() {
      return port!
    },
  }
}
it("keeps snapshot transport while hidden and aborts unconfirmed actions", async () => {
  const f = fixture(); f.ready();
  let signal: AbortSignal | undefined;
  f.handlers.requestAction.mockImplementation(async (_params, next) => {
    signal = next;
    return await new Promise<null>(resolve => next.addEventListener("abort", () => resolve(null), { once: true }));
  });
  f.send("requestAction", { actionId: "apply", args: {}, expectedRevision: 1 });
  await vi.waitFor(() => expect(signal).toBeDefined());
  f.hide(); expect(signal!.aborted).toBe(true);
  f.send("dismiss", { expectedRevision: 1 }); f.send();
  await vi.waitFor(() => expect(f.received.some(m => m.id === "2" && m.error?.code === "plugin_ui_hidden")).toBe(true));
  await vi.waitFor(() => expect(f.received.some(m => m.id === "3" && m.result?.revision === 1)).toBe(true));
});
it("lets an in-flight snapshot finish while hidden", async () => {
  const f = fixture(); f.ready();
  let finish!: () => void;
  f.handlers.getSnapshot.mockImplementation(async () => {
    await new Promise<void>(resolve => { finish = resolve }); return snapshot;
  });
  f.send(); await vi.waitFor(() => expect(finish).toBeDefined());
  f.hide(); finish();
  await vi.waitFor(() => expect(f.received.some(m => m.id === "1" && m.result?.revision === 1)).toBe(true));
});
it("delivers an already accepted action result after hiding", async () => {
  const f = fixture(); f.ready();
  let finish!: () => void;
  f.handlers.requestAction.mockImplementation(async (_params, signal) => {
    f.bridge.markAccepted(signal);
    await new Promise<void>(resolve => { finish = resolve }); return null;
  });
  f.send("requestAction", { actionId: "apply", args: {}, expectedRevision: 1 });
  await vi.waitFor(() => expect(finish).toBeDefined()); f.hide(); finish();
  await vi.waitFor(() => expect(f.received.some(m => m.id === "1" && m.result === null)).toBe(true));
});
it("refuses all new business methods while hidden and sidebar resize", async () => {
  const f = fixture(); f.ready(); f.hide();
  f.send("requestAction", { actionId: "apply", expectedRevision: 1, args: {} });
  f.send("dismiss", { expectedRevision: 1 });
  f.send("requestConversation", { mode: "draft", expectedRevision: 1, text: "Follow up", data: {} });
  await vi.waitFor(() => expect(f.received.filter(message => message.error?.code === "plugin_ui_hidden")).toHaveLength(3));
  f.bridge.pushSnapshot({ ...snapshot, surface: "session-sidebar" }); f.send("resize", { height: 320 });
  await vi.waitFor(() => expect(f.received.some(message => message.id === "4" && message.error?.code === "plugin_ui_surface_not_supported")).toBe(true));
});
it("uses exact iframe source, initializes once and serves JSON over a real port", async () => {
  const f = fixture()
  f.ready({})
  expect(f.child.postMessage).not.toHaveBeenCalled()
  f.ready()
  f.ready()
  expect(f.child.postMessage).toHaveBeenCalledTimes(1)
  f.send()
  await vi.waitFor(() =>
    expect(f.received.some((m) => m.id === "1" && m.result?.revision === 1)).toBe(true)
  )
})
it("blocks old mounts, extra keys, duplicate ids, unknown methods and readonly actions", async () => {
  const f = fixture()
  f.ready()
  f.send(
    "requestAction",
    { actionId: "apply", args: {}, expectedRevision: 1 },
    { mountId: "40000000-0000-4000-8000-000000000001" }
  )
  f.send(
    "requestAction",
    { actionId: "apply", args: {}, expectedRevision: 1 },
    { html: "<script/>" }
  )
  f.send("unknown")
  f.send()
  f.send("requestAction", { actionId: "apply", args: {}, expectedRevision: 1 }, { id: "4" })
  f.handlers.getSnapshot.mockResolvedValue({ ...snapshot, readOnly: true })
  f.bridge.pushSnapshot({ ...snapshot, readOnly: true })
  f.send("requestAction", { actionId: "apply", args: {}, expectedRevision: 1 })
  await vi.waitFor(() => expect(f.received.filter((m) => m.error)).toHaveLength(5))
  expect(f.handlers.requestAction).not.toHaveBeenCalled()
})
it("allows one confirmation, aborts it on disposal and never executes a late request", async () => {
  const f = fixture()
  f.ready()
  let pendingSignal: AbortSignal | undefined
  f.handlers.requestAction.mockImplementation(async (_params, signal) => {
    pendingSignal = signal
    return await new Promise<null>((resolve) =>
      signal.addEventListener("abort", () => resolve(null), { once: true })
    )
  })
  f.send("requestAction", { actionId: "apply", args: {}, expectedRevision: 1 })
  await vi.waitFor(() => expect(f.handlers.requestAction).toHaveBeenCalledTimes(1))
  f.send("dismiss", { expectedRevision: 1 })
  await vi.waitFor(() =>
    expect(f.received.some((m) => m.error?.code === "plugin_ui_confirmation_pending")).toBe(true)
  )
  f.bridge.dispose()
  expect(pendingSignal?.aborted).toBe(true)
  f.send()
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(f.handlers.getSnapshot).not.toHaveBeenCalled()
})
it("limits pending requests", async () => {
  const f = fixture()
  f.ready()
  f.handlers.getSnapshot.mockImplementation(async () => await new Promise(() => {}))
  for (let i = 0; i < 17; i++) f.send()
  await vi.waitFor(() =>
    expect(f.received.some((m) => m.error?.code === "plugin_ui_too_many_requests")).toBe(true)
  )
  expect(f.handlers.getSnapshot).toHaveBeenCalledTimes(16)
})
it("counts invalid messages in the rolling rate limit", async () => {
  const f = fixture()
  f.ready()
  for (let i = 0; i < 60; i++) f.send("unknown")
  f.send()
  await vi.waitFor(() =>
    expect(
      f.received.some((m) => m.id === "61" && m.error?.code === "plugin_ui_rate_limited")
    ).toBe(true)
  )
  expect(f.handlers.getSnapshot).not.toHaveBeenCalled()
})
it("closes the handshake at ten seconds and ignores a late ready", async () => {
  vi.useFakeTimers()
  const f = fixture()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(f.onError).toHaveBeenCalledWith("plugin_ui_timeout")
  f.ready()
  expect(f.child.postMessage).not.toHaveBeenCalled()
})
