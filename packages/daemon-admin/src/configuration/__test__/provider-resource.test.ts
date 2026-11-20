import { CURRENT_PROTOCOL_VERSION, HttpTransport, RuntimeResource } from "@rzx/client";
import { expect, it } from "vitest";
import { ProviderResource } from "../index.js";

it("writes provider configuration through the authenticated daemon transport", async () => {
  const calls: Array<{ path: string; method: string; body: unknown; authorization: string | null }> = [];
  const transport = new HttpTransport({
    baseUrl: "http://daemon.test",
    token: "fixture-token",
    fetch: async (url, init) => {
      const request = new Request(url, init);
      const path = new URL(request.url).pathname;
      const body = request.body ? await request.json() : undefined;
      calls.push({ path, method: request.method, body, authorization: request.headers.get("authorization") });
      if (path === "/capabilities") return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} });
      if (request.method === "DELETE") return Response.json({ ok: true });
      return Response.json({ provider: { name: body.id ?? "catalog", displayName: body.displayName, custom: path.includes("/custom") } }, { status: request.method === "POST" ? 201 : 200 });
    },
  });
  const providers = new ProviderResource(transport);
  const input = {
    id: "office-gateway",
    displayName: "Office Gateway",
    baseUrl: "https://gateway.example/v1",
    apiFormat: "openai" as const,
    apiKey: "fixture-key",
    models: [{ id: "team-model", displayName: "Team Model" }],
  };
  const updated = { ...input, displayName: "Office AI" };
  const headers = { "User-Agent": "{{userAgent}}" };
  const secretHeaders = { "X-Removed": null };

  expect(calls).toEqual([]);
  await expect(providers.createCustomProvider(input)).resolves.toMatchObject({ name: input.id, custom: true });
  await expect(providers.updateCustomProvider(input.id, updated)).resolves.toMatchObject({ displayName: updated.displayName });
  await expect(providers.removeCustomProvider(input.id)).resolves.toBeUndefined();
  await expect(providers.connectCatalogProvider("remote/model", "fixture-key")).resolves.toBeDefined();
  await expect(providers.connectCatalogProvider("remote/model", { apiKey: "fixture-key", headers: { "X-Session": "{{sessionId}}" } })).resolves.toBeDefined();
  await expect(providers.updateCatalogProviderHeaders("remote/model", headers, { secretHeaders })).resolves.toBeDefined();
  await expect(providers.disconnectCatalogProvider("remote/model")).resolves.toBeUndefined();

  expect(calls[0]).toEqual({ path: "/capabilities", method: "GET", body: undefined, authorization: null });
  expect(calls.slice(1)).toEqual([
    { path: "/providers/custom", method: "POST", body: input },
    { path: "/providers/custom/office-gateway", method: "PATCH", body: updated },
    { path: "/providers/custom/office-gateway", method: "DELETE", body: undefined },
    { path: "/providers/catalog/remote%2Fmodel/connect", method: "POST", body: { apiKey: "fixture-key" } },
    { path: "/providers/catalog/remote%2Fmodel/connect", method: "POST", body: { apiKey: "fixture-key", headers: { "X-Session": "{{sessionId}}" } } },
    { path: "/providers/catalog/remote%2Fmodel", method: "PATCH", body: { headers, secretHeaders } },
    { path: "/providers/catalog/remote%2Fmodel/connect", method: "DELETE", body: undefined },
  ].map(call => ({ ...call, authorization: "Bearer fixture-token" })));
});

it("uses the public runtime for model reads and an explicit query for provider refresh", async () => {
  const calls: string[] = [];
  const signal = new AbortController().signal;
  const models = [{ name: "test", displayName: "Test", models: [] }];
  const transport = new HttpTransport({ baseUrl: "http://daemon.test", fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/capabilities") return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} });
    expect(init?.signal).toBe(signal);
    calls.push(url.pathname + url.search);
    return Response.json({ providers: models });
  } });

  await expect(new RuntimeResource(transport).listModels({ signal })).resolves.toEqual(models);
  await expect(new ProviderResource(transport).refreshModels({ signal })).resolves.toEqual(models);
  expect(calls).toEqual(["/models", "/models?refresh=true"]);
});
