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
      return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: { pluginUi: 1 } });
    }
    requests.push(request);
    return Response.json({ receipt: { instanceId }, instance: { instanceId } });
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
