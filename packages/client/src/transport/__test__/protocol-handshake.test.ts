import { describe, expect, it, vi } from "vitest";
import { CURRENT_PROTOCOL_VERSION } from "@vykor/protocol";
import { HttpTransport } from "../http-transport.js";
import { VykorClient } from "../http-client.js";

const capabilities = (version = CURRENT_PROTOCOL_VERSION) => Response.json({
  serverVersion: "test",
  protocol: { version },
  features: { jobs: 2 },
});

describe("mandatory protocol handshake", () => {
  it("shares one handshake across concurrent HTTP, event and terminal streams", async () => {
    const calls: Array<{ path: string; headers: Headers }> = [];
    let release!: (response: Response) => void;
    const handshake = new Promise<Response>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, headers: new Headers(init?.headers) });
      if (path === "/capabilities") return handshake;
      if (path.endsWith("/stream")) return new Response("");
      return Response.json({ sessions: [] });
    });
    const client = new VykorClient({ baseUrl: "http://daemon", fetch: fetchImpl });
    const requests = [
      client.sessions.list(),
      client.events.stream()[Symbol.asyncIterator]().next(),
      client.terminals.streamEvents()[Symbol.asyncIterator]().next(),
    ];
    expect(calls.map((call) => call.path)).toEqual(["/capabilities"]);
    release(capabilities());
    await Promise.all(requests);
    await client.sessions.list();
    expect(calls.filter((call) => call.path === "/capabilities")).toHaveLength(1);
    for (const call of calls.slice(1)) {
      expect(call.headers.get("x-vykor-protocol-version")).toBe(String(CURRENT_PROTOCOL_VERSION));
    }
  });

  it.each([3, CURRENT_PROTOCOL_VERSION + 1])("does not send HTTP or SSE business requests to protocol %s", async (version) => {
    const fetchImpl = vi.fn(async () => capabilities(version));
    const client = new VykorClient({ baseUrl: "http://daemon", fetch: fetchImpl });
    const results = await Promise.allSettled([
      client.sessions.list(),
      client.events.stream()[Symbol.asyncIterator]().next(),
      client.terminals.streamEvents()[Symbol.asyncIterator]().next(),
    ]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures and allows an explicit retry; raw requests cannot override the version", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(capabilities(3))
      .mockResolvedValueOnce(capabilities())
      .mockResolvedValue(new Response("payload"));
    const transport = new HttpTransport({ baseUrl: "http://daemon", fetch: fetchImpl });
    await expect(transport.requestResponse("/attachments/a")).rejects.toThrow(/protocol/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await transport.requestResponse("/attachments/a", {
      headers: { "X-Vykor-Protocol-Version": "3" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(new Headers(fetchImpl.mock.calls[2]![1].headers).get("x-vykor-protocol-version")).toBe(String(CURRENT_PROTOCOL_VERSION));
  });

  it("exempts health and capabilities, including query strings, without marking the connection verified", async () => {
    const fetchImpl = vi.fn(async () => capabilities());
    const transport = new HttpTransport({ baseUrl: "http://daemon", fetch: fetchImpl });
    await transport.request("/health?probe=1");
    await transport.request("/capabilities");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await transport.request("/sessions");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("blocks business requests on malformed or failed capabilities responses", async () => {
    for (const response of [Response.json({}), new Response("failed", { status: 500 })]) {
      const fetchImpl = vi.fn(async () => response);
      const transport = new HttpTransport({ baseUrl: "http://daemon", fetch: fetchImpl });
      await expect(transport.request("/sessions")).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("shares raw and JSON requests while cancellation only stops the cancelled waiter", async () => {
    let release!: (response: Response) => void;
    const handshake = new Promise<Response>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/capabilities") ? handshake : Response.json({ ok: true }));
    const transport = new HttpTransport({ baseUrl: "http://daemon", fetch: fetchImpl });
    const controller = new AbortController();
    const cancelled = transport.request("/cancelled", { signal: controller.signal });
    const accepted = transport.requestResponse("/current");
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release(capabilities());
    await expect(accepted).resolves.toMatchObject({ status: 200 });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "http://daemon/capabilities", "http://daemon/current",
    ]);
  });
});
