import { describe, expect, it, vi } from "vitest";
import { SessionResource } from "../session-resource.js";
import { HttpTransport } from "../../../transport/http-transport.js";
import { CURRENT_PROTOCOL_VERSION } from "@vykor/protocol";

it.each([1, 2])("checks steer capability %s before posting a bound follow-up", async steer => {
  const posted: unknown[] = [];
  const resource = new SessionResource(new HttpTransport({
    baseUrl: "http://localhost:9000",
    fetch: async (_url, init) => {
      if (init?.method === "POST") {
        posted.push(JSON.parse(String(init.body)));
        return Response.json({ input: { id: "input" } });
      }
      return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: { steer } });
    },
  }));
  const bound = { id: "input", items: [{ type: "text" as const, text: "clarify" }], delivery: "steer" as const, expectedActiveRunId: "running" };
  if (steer === 2) {
    await resource.admitPrompt("session", bound);
    expect(posted).toEqual([bound]);
  } else {
    await expect(resource.admitPrompt("session", bound)).rejects.toThrow("targeting an active Run");
    expect(posted).toEqual([]);
    const { expectedActiveRunId: _target, ...legacy } = bound;
    await resource.admitPrompt("session", legacy);
    expect(posted).toEqual([legacy]);
  }
});

describe("structured prompt delivery", () => {
  it.each([["edit", false], ["edit", true], ["resume", false], ["resume", true]] as const)("gates explicit schema in %s (supported=%s)", async (method, supported) => {
    const posted: unknown[] = [], outputSchema = { type: "string" };
    const fetcher = async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") { posted.push(JSON.parse(String(init.body))); return Response.json({ input: { id: "i" } }); }
      return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: supported ? { structuredDelivery: 1 } : {} });
    };
    const resource = new SessionResource(new HttpTransport({ baseUrl: "http://localhost:9000", fetch: fetcher as typeof fetch }));
    const result = method === "edit" ? resource.editLatestPrompt("s", { id: "i", items: [{ type: "text", text: "report" }], sourceMessageId: "m", outputSchema })
      : resource.resumeInterruptedRun("s", "r", { outputSchema });
    if (supported) { await result; expect(posted).toEqual([expect.objectContaining({ outputSchema })]); }
    else { await expect(result).rejects.toThrow(/outputSchema/); expect(posted).toEqual([]); }
  });
  it.each(["edit", "resume"])("also gates metadata.outputSchema in %s requests", async method => {
    const posted: unknown[] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") { posted.push(init.body); return Response.json({ input: { id: "i1" } }); }
      return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: { structuredDelivery: 1 } });
    });
    const resource = new SessionResource(new HttpTransport({ baseUrl: "http://localhost:9000", fetch: fetcher as typeof fetch }));
    const metadata = { outputSchema: { type: "string" } };
    const result = method === "edit"
      ? resource.editLatestPrompt("s1", { id: "i1", items: [{ type: "text", text: "report" }], sourceMessageId: "m1", metadata })
      : resource.resumeInterruptedRun("s1", "r1", { metadata });
    await expect(result).rejects.toThrow(/structured.*delivery|outputSchema/i);
    expect(posted).toEqual([]);
  });
  it.each([[false, false], [true, false], [false, true], [true, true]])("requires explicit outputSchema and advertised support (supported=%s metadata=%s)", async (supported, metadata) => {
    const outputSchema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
    const posted: unknown[] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") { posted.push(JSON.parse(String(init.body))); return Response.json({ input: { id: "i1" } }); }
      return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: supported ? { structuredDelivery: 1 } : {} });
    });
    const resource = new SessionResource(new HttpTransport({ baseUrl: "http://localhost:9000", fetch: fetcher as typeof fetch }));
    const constraint = metadata ? { metadata: { outputSchema } } : { outputSchema };
    const result = resource.admitPrompt("s1", { id: "i1", items: [{ type: "text", text: "report" }], ...constraint });
    if (supported && !metadata) { await result; expect(posted).toEqual([expect.objectContaining(constraint)]); }
    else { await expect(result).rejects.toThrow(/structured.*delivery|outputSchema/i); expect(posted).toEqual([]); }
  });
});
