import { expect, it } from "vitest";
import { CURRENT_PROTOCOL_VERSION, type PluginAppToolRequest } from "@vykor/protocol";
import { VykorClient } from "../index.js";
it("copies fixed request before transport handshake and verifies response identity and revision", async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const requests: Request[] = [];
  const input: PluginAppToolRequest = { source: { sessionId: "s /", appId: "a" }, lease: { token: "opaque", backendGeneration: "g" },
    requestId: "request", expectedRevision: 7, toolName: "save", args: { value: 1 } };
  let wrong = false, badRevision = false;
  const client = new VykorClient({ baseUrl: "http://localhost", fetch: async (url, init) => {
    if (String(url).endsWith("/capabilities")) { await gate; return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: { pluginApps: 1 } }); }
    const request = new Request(url, init); requests.push(request);
    return Response.json({ receipt: { source: { sessionId: "s /", appId: wrong ? "foreign" : "a" }, requestId: "request", expectedRevision: 7,
      acceptedRevision: badRevision ? 9 : 8, runId: "run", status: "pending", executionState: "not_started" } });
  } });
  const pending = client.pluginApps.invoke(input);
  input.args.value = 99; input.expectedRevision = 9; release();
  expect((await pending).receipt.expectedRevision).toBe(7);
  expect(await requests[0]!.json()).toMatchObject({ expectedRevision: 7, args: { value: 1 }, lease: { token: "opaque" } });
  expect(new URL(requests[0]!.url).pathname).toBe("/sessions/s%20%2F/plugin-apps/a/actions");
  wrong = true;
  await expect(client.pluginApps.getAction(input.source, "request")).rejects.toThrow("mismatch");
  wrong = false; badRevision = true;
  await expect(client.pluginApps.getAction(input.source, "request")).rejects.toThrow("mismatch");
});
it("rejects invalid fixed args before networking", async () => {
  const client = new VykorClient({ baseUrl: "http://localhost", fetch: async () => { throw new Error("unexpected network"); } });
  await expect(client.pluginApps.invoke({ source: { sessionId: "s", appId: "a" }, lease: { token: "t", backendGeneration: "g" },
    requestId: "r", expectedRevision: 0, toolName: "save", args: { value: NaN } })).rejects.toThrow("invalid_json");
});
