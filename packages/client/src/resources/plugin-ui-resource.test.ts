import { expect, it } from "vitest";
import { CURRENT_PROTOCOL_VERSION } from "@vykor/protocol";
import { VykorClient } from "../index.js";

const instanceId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
it("owns validated action JSON before handshake and passes signals through all five methods", async () => {
  const requests: Request[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const client = new VykorClient({ baseUrl: "http://localhost", fetch: async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/capabilities")) {
      await gate;
      return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: { pluginUi: 2 } });
    }
    requests.push(request);
    return Response.json({ receipt: { instanceId }, instance: { instanceId }, conversation: { draft: false, submit: false } });
  } });
  const controller = new AbortController();
  const input = { requestId, expectedRevision: 1, actionId: "apply", args: { value: 1 } };
  const admitted = client.pluginUi.invokeAction("opaque / session", instanceId, input, { signal: controller.signal });
  input.args.value = NaN; release(); await admitted;
  expect(await requests[0]!.json()).toMatchObject({ args: { value: 1 } });
  await client.pluginUi.get("s", instanceId, { signal: controller.signal });
  await client.pluginUi.getDocument("s", instanceId, { signal: controller.signal });
  await client.pluginUi.getAction("s", instanceId, requestId, { signal: controller.signal });
  await client.pluginUi.dismiss("s", instanceId, { requestId, expectedRevision: 1 }, { signal: controller.signal });
  expect(requests.map(request => new URL(request.url).pathname)).toEqual([
    `/sessions/opaque%20%2F%20session/plugin-ui/${instanceId}/actions`,
    `/sessions/s/plugin-ui/${instanceId}`, `/sessions/s/plugin-ui/${instanceId}/document`,
    `/sessions/s/plugin-ui/${instanceId}/actions/${requestId}`, `/sessions/s/plugin-ui/${instanceId}/dismiss`,
  ]);
  controller.abort();
  expect(requests.every(request => request.signal.aborted)).toBe(true);
});

it.each([NaN, Infinity, undefined, () => 1])("rejects non-JSON args %s before sending a request", async value => {
  const client = new VykorClient({ baseUrl: "http://localhost", fetch: async () => { throw new Error("unexpected network request"); } });
  await expect(client.pluginUi.invokeAction("s", instanceId, { requestId, expectedRevision: 1, actionId: "apply", args: { value } as any }))
    .rejects.toMatchObject({ code: "invalid_request" });
});

it("owns conversation data before handshake, validates receipts, encodes paths and forwards signals", async () => {
  const requests: Request[] = []; const controller = new AbortController();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const receipt = { kind: "conversation", mode: "submit", instanceId, revision: 2, requestId, inputId: "input", runId: "run", status: "pending" };
  const client = new VykorClient({ baseUrl: "http://localhost", fetch: async (url, init) => {
    if (String(url).endsWith("/capabilities")) { await gate; return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: { pluginUi: 2, pluginUiConversation: 1 } }); }
    const req = new Request(url, init); requests.push(req);
    return Response.json(req.url.endsWith("prepare") ? { mode: "draft", instanceId, revision: 1, promptText: "prepared" } : { receipt });
  } });
  const payload = { mode: "draft" as const, expectedRevision: 1, text: "explain", data: { value: 1 } };
  const pending = client.pluginUi.prepareConversation("opaque / session", instanceId, payload, { signal: controller.signal });
  payload.data.value = 2; release(); expect(await pending).toMatchObject({ promptText: "prepared" });
  expect((await requests[0]!.json()).data).toEqual({ value: 1 });
  expect(await client.pluginUi.submitConversation("s", instanceId, { requestId, expectedRevision: 1, text: "explain", data: {} }, { signal: controller.signal })).toEqual(receipt);
  expect(await client.pluginUi.getConversationSubmission("s", instanceId, requestId, { signal: controller.signal })).toEqual(receipt);
  expect(requests.map(req => new URL(req.url).pathname)).toEqual([
    `/sessions/opaque%20%2F%20session/plugin-ui/${instanceId}/conversation/prepare`,
    `/sessions/s/plugin-ui/${instanceId}/conversation/submissions`,
    `/sessions/s/plugin-ui/${instanceId}/conversation/submissions/${requestId}`,
  ]);
  controller.abort(); expect(requests.every(req => req.signal.aborted)).toBe(true);
});

it("rejects corrupt conversation receipts", async () => {
  const client = new VykorClient({ baseUrl: "http://localhost", fetch: async url => Response.json(String(url).endsWith("capabilities")
    ? { serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: { pluginUi: 2, pluginUiConversation: 1 } }
    : { receipt: { mode: "submit" } }) });
  await expect(client.pluginUi.getConversationSubmission("s", instanceId, requestId)).rejects.toMatchObject({ code: "invalid_request" });
});

it.each([undefined, { draft: true }, { draft: true, submit: "true" }])("rejects missing or nonboolean GET conversation capability %s", async conversation => {
  const client = new VykorClient({ baseUrl: "http://localhost", fetch: async url => Response.json(String(url).endsWith("capabilities")
    ? { serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: { pluginUi: 2 } }
    : { conversation }) });
  await expect(client.pluginUi.get("s", instanceId)).rejects.toMatchObject({ code: "invalid_request" });
});
