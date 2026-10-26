import { describe, expect, it, vi } from "vitest";
import { SessionResource } from "../session-resource.js";
import { HttpTransport } from "../../../transport/http-transport.js";
import { CURRENT_PROTOCOL_VERSION } from "@vykor/protocol";

describe("structured prompt delivery", () => {
  it.each(["edit", "resume"])("also gates metadata.outputSchema in %s requests", async method => {
    const posted: unknown[] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") { posted.push(init.body); return Response.json({ input: { id: "i1" } }); }
      return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: {} });
    });
    const resource = new SessionResource(new HttpTransport({ baseUrl: "http://localhost:9000", fetch: fetcher as typeof fetch }));
    const metadata = { outputSchema: { type: "string" } };
    const result = method === "edit"
      ? resource.editLatestPrompt("s1", { id: "i1", items: [{ type: "text", text: "report" }], sourceMessageId: "m1", metadata })
      : resource.resumeInterruptedRun("s1", "r1", { metadata });
    await expect(result).rejects.toThrow(/structured.*delivery|outputSchema/i);
    expect(posted).toEqual([]);
  });
  it.each([[false, false], [true, false], [false, true], [true, true]])("requires advertised support before submitting outputSchema (supported=%s metadata=%s)", async (supported, metadata) => {
    const outputSchema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };
    const posted: unknown[] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") { posted.push(JSON.parse(String(init.body))); return Response.json({ input: { id: "i1" } }); }
      return Response.json({ serverVersion: "test", protocol: { version: CURRENT_PROTOCOL_VERSION }, features: supported ? { structuredDelivery: 1 } : {} });
    });
    const resource = new SessionResource(new HttpTransport({ baseUrl: "http://localhost:9000", fetch: fetcher as typeof fetch }));
    const constraint = metadata ? { metadata: { outputSchema } } : { outputSchema };
    const result = resource.admitPrompt("s1", { id: "i1", items: [{ type: "text", text: "report" }], ...constraint });
    if (supported) { await result; expect(posted).toEqual([expect.objectContaining(constraint)]); }
    else { await expect(result).rejects.toThrow(/structured.*delivery|outputSchema/i); expect(posted).toEqual([]); }
  });
});
