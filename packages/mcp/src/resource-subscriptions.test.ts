import { expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { captureMcpAppResources } from "./app-resources.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
function fixture() {
  let notify!: (event: { params: { uri: string } }) => void;
  const client = { getServerCapabilities: () => ({ resources: { subscribe: true } }),
    setNotificationHandler: vi.fn((_schema, callback) => { notify = callback; }),
    subscribeResource: vi.fn(async () => ({})), unsubscribeResource: vi.fn(async () => ({})) };
  return { client, port: captureMcpAppResources(client as unknown as Client, "g", () => true), notify: (uri: string) => notify({ params: { uri } }) };
}
it("shares a concrete client's subscriptions but isolates clients and URIs", async () => {
  const a = fixture(), b = fixture(), first = vi.fn(), second = vi.fn(), foreign = vi.fn();
  const one = new AbortController(), two = new AbortController(), three = new AbortController();
  await a.port.subscribeResource!("notes://same", first, one.signal);
  await a.port.subscribeResource!("notes://same", second, two.signal);
  await b.port.subscribeResource!("notes://same", foreign, three.signal);
  a.notify("notes://other"); expect(first).not.toHaveBeenCalled();
  a.notify("notes://same"); expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1); expect(foreign).not.toHaveBeenCalled();
  one.abort(); await Promise.resolve(); expect(a.client.unsubscribeResource).not.toHaveBeenCalled();
  two.abort(); three.abort(); await vi.waitFor(() => expect(a.client.unsubscribeResource).toHaveBeenCalledTimes(1));
  expect(a.client.subscribeResource).toHaveBeenCalledTimes(1); expect(a.client.setNotificationHandler).toHaveBeenCalledTimes(1);
});
it("unsubscribes late success after abort, suppresses old generation and leaves a newer reader alive", async () => {
  const f = fixture(), listener = vi.fn(), old = new AbortController();
  let finish!: () => void, current = true;
  f.client.subscribeResource.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({}); }));
  const port = captureMcpAppResources(f.client as unknown as Client, "old", () => current);
  const pending = port.subscribeResource!("notes://same", listener, old.signal);
  const rejected = expect(pending).rejects.toThrow("backend_changed");
  await vi.waitFor(() => expect(finish).toBeDefined()); current = false; old.abort(); finish(); await rejected;
  await vi.waitFor(() => expect(f.client.unsubscribeResource).toHaveBeenCalledTimes(1));
  f.notify("notes://same"); expect(listener).not.toHaveBeenCalled();
  const next = new AbortController(); await f.port.subscribeResource!("notes://same", listener, next.signal);
  f.notify("notes://same"); expect(listener).toHaveBeenCalledTimes(1); next.abort();
});
it("keeps URI-local unsupported subscriptions from cancelling valid readers, but propagates auth errors", async () => {
  const f = fixture(), abort = new AbortController(), listener = vi.fn();
  f.client.subscribeResource.mockRejectedValueOnce(new McpError(ErrorCode.InvalidParams, "resource_not_subscribable"));
  const stop = await f.port.subscribeResource!("ui://editor", listener, abort.signal);
  await f.port.subscribeResource!("notes://same", listener, abort.signal);
  f.notify("notes://same"); expect(listener).toHaveBeenCalledTimes(1);
  f.client.subscribeResource.mockRejectedValueOnce(new McpError(-32001, "not authorized"));
  await expect(f.port.subscribeResource!("notes://private", listener, abort.signal)).rejects.toThrow("not authorized");
  expect(abort.signal.aborted).toBe(false); stop(); abort.abort();
});
