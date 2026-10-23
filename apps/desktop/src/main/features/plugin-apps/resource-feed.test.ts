import { expect, it, vi } from "vitest"
import { VykorClient } from "@rzx/client"
import { WindowResourceFeed } from "./resource-feed"
import type { AppMountBinding } from "./plugin-app-service"

it("shares one window stream, filters exact notices, and replaces old leases and clients", async () => {
  const streams: Array<{ signal: AbortSignal; watches: Array<{ leaseGeneration: number }>; emit(value: unknown): void }> = []
  const makeClient = () => new VykorClient({ baseUrl: "http://localhost", token: "secret", fetch: async (url, init) => {
    if (new URL(String(url)).pathname === "/capabilities") return Response.json({ serverVersion: "test", protocol: { version: 5 }, features: { pluginApps: 1 } })
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret")
    return new Response(new ReadableStream({ start(controller) {
      streams.push({ signal: init!.signal!, watches: JSON.parse(String(init?.body)).watches,
        emit: value => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)) })
      init!.signal!.addEventListener("abort", () => controller.close(), { once: true })
    } }), { headers: { "content-type": "text/event-stream" } })
  } })
  const client = makeClient(), emit = vi.fn(), feed = new WindowResourceFeed(emit)
  const mount = (id: string) => ({ mountId: id, admitted: true, online: true, client,
    response: { source: { sessionId: "s", appId: id }, app: { backendKind: "mcp-server" }, lease: { token: id, backendGeneration: "g" } } }) as AppMountBinding
  const a = mount("a"), b = mount("b")
  try {
    feed.read(a, "notes://a"); await vi.waitFor(() => expect(streams).toHaveLength(1))
    feed.read(b, "notes://b"); await vi.waitFor(() => expect(streams).toHaveLength(2))
    expect(streams[0]!.signal.aborted).toBe(true)
    const current = streams[1]!, generation = current.watches[0]!.leaseGeneration
    expect(current.watches).toHaveLength(2)
    current.emit({ kind: "resync", runtimeEpoch: "current" }); await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2)); emit.mockClear()
    const notice = { kind: "resource-updated", runtimeEpoch: "current", appId: "a", leaseGeneration: generation, uri: "notes://a" }
    current.emit({ ...notice, runtimeEpoch: "old" }); current.emit({ ...notice, appId: "other" })
    current.emit({ ...notice, leaseGeneration: generation - 1 }); current.emit({ ...notice, uri: "notes://b" }); current.emit(notice)
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1)); expect(emit).toHaveBeenCalledWith(a)
    a.response.lease = { token: "new", backendGeneration: "next" }; feed.sync()
    await vi.waitFor(() => expect(streams).toHaveLength(3)); expect(current.signal.aborted).toBe(true)
    a.client = b.client = makeClient(); feed.sync()
    await vi.waitFor(() => expect(streams).toHaveLength(4)); expect(streams[2]!.signal.aborted).toBe(true)
    feed.remove(a); feed.remove(b)
    expect(streams[3]!.signal.aborted).toBe(true)
  } finally { feed.dispose() }
})
