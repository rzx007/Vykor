import { CURRENT_PROTOCOL_VERSION, HttpTransport } from "@rzx/client";
import type { PluginAppToolRequest } from "@vykor/protocol";
import { expect, it } from "vitest";
import { PluginAppResource } from "../plugin-app-resource";

it("copies the fixed request before handshake and checks response identity and revision", async () => {
  const handshake = Promise.withResolvers<void>();
  const requests: Request[] = [];
  const input: PluginAppToolRequest = {
    source: { sessionId: "s /", appId: "a" }, lease: { token: "opaque", backendGeneration: "g" },
    requestId: "request", expectedRevision: 7, toolName: "save", args: { value: 1 },
  };
  const receipt = {
    source: { ...input.source }, requestId: "request", expectedRevision: 7,
    acceptedRevision: 8, runId: "run", status: "pending", executionState: "not_started",
  };
  const resource = new PluginAppResource(new HttpTransport({ baseUrl: "http://daemon.test", fetch: async (url, init) => {
    if (new URL(String(url)).pathname === "/capabilities") {
      await handshake.promise;
      return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: { pluginApps: 1 } });
    }
    requests.push(new Request(url, init));
    return Response.json({ receipt });
  } }));

  const pending = resource.invoke(input);
  input.args.value = 99;
  input.expectedRevision = 9;
  handshake.resolve();
  expect((await pending).receipt.expectedRevision).toBe(7);
  expect(await requests[0]!.json()).toMatchObject({ expectedRevision: 7, args: { value: 1 }, lease: { token: "opaque" } });
  expect(new URL(requests[0]!.url).pathname).toBe("/sessions/s%20%2F/plugin-apps/a/actions");

  receipt.source.appId = "foreign";
  await expect(resource.getAction(input.source, "request")).rejects.toThrow("plugin_app_receipt_mismatch");
  receipt.source.appId = input.source.appId;
  receipt.acceptedRevision = 9;
  await expect(resource.getAction(input.source, "request")).rejects.toThrow("plugin_app_receipt_mismatch");
});

it("rejects invalid fixed arguments before networking", async () => {
  const resource = new PluginAppResource(new HttpTransport({ baseUrl: "http://daemon.test", fetch: async () => { throw new Error("unexpected network"); } }));
  await expect(resource.invoke({ source: { sessionId: "s", appId: "a" }, lease: { token: "t", backendGeneration: "g" },
    requestId: "r", expectedRevision: 0, toolName: "save", args: { value: NaN } })).rejects.toThrow("invalid_json");
});
