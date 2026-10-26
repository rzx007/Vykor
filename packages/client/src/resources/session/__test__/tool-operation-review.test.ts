import { expect, it } from "vitest";
import { SessionResource } from "../session-resource.js";
import { HttpTransport } from "../../../transport/http-transport.js";
import { CURRENT_PROTOCOL_VERSION } from "@vykor/protocol";

it("routes manual review to the encoded session and operation with explicit revision and evidence", async () => {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const transport = new HttpTransport({ baseUrl: "http://localhost:9000", fetch: (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/capabilities")) return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} });
    calls.push({ url: String(url), method: init?.method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return Response.json(init?.method === "POST" ? { operation: { state: "unknown", revision: 5 } } : String(url).includes("operation%2Fone") ? { operation: { inputPreview: "bounded" } } : { operations: [{ operationId: "operation/one", state: "unknown" }] });
  }) as typeof fetch });
  const resource = new SessionResource(transport) as SessionResource & {
    listUnknownToolOperations?: (id: string) => Promise<unknown>;
    inspectToolOperation?: (id: string, op: string) => Promise<unknown>;
    reconcileToolOperation?: (id: string, op: string, input: unknown) => Promise<unknown>;
  };
  expect(await resource.listUnknownToolOperations?.("session/one")).toEqual([{ operationId: "operation/one", state: "unknown" }]);
  expect(await resource.inspectToolOperation!("session/one", "operation/one")).toEqual({ inputPreview: "bounded" });
  const input = { expectedRevision: 4, outcome: "applied", evidence: "checked record, response unavailable" };
  expect(await resource.reconcileToolOperation!("session/one", "operation/one", input)).toEqual({ state: "unknown", revision: 5 });
  expect(calls.map(call => call.url)).toEqual(["http://localhost:9000/sessions/session%2Fone/tool-operations", "http://localhost:9000/sessions/session%2Fone/tool-operations/operation%2Fone", "http://localhost:9000/sessions/session%2Fone/tool-operations/operation%2Fone/reconcile"]);
  expect(calls[2]).toMatchObject({ method: "POST", body: input });
});
