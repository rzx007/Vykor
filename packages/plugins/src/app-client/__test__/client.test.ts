import { describe, expect, it } from "vitest";
import { createPluginAppClient, definePluginAppTool } from "../client.js";

const save = definePluginAppTool<
  { expectedRevision: number; operationId: string; text: string },
  { revision: number; saved: boolean }
>("save_note_draft");

describe("plugin page tool client", () => {
  it("uses the existing App transport once with the original arguments and options", async () => {
    const input = { expectedRevision: 4, operationId: "save-1", text: "draft" };
    const options = { signal: new AbortController().signal, timeout: 1200 };
    const result = { content: [{ type: "text", text: "saved" }], structuredContent: { revision: 5, saved: true }, _meta: { receipt: "original" } };
    const requests: unknown[] = [];
    const app = {
      callServerTool(request: { name: string; arguments?: Record<string, unknown> }, receivedOptions?: typeof options) {
        expect(this).toBe(app);
        expect(request.arguments).toBe(input);
        expect(receivedOptions).toBe(options);
        requests.push(request);
        return Promise.resolve(result);
      },
    };
    const client = createPluginAppClient(app);
    expect(requests).toHaveLength(0);
    expect(await client.call(save, input, options)).toBe(result);
    expect(requests).toEqual([{ name: "save_note_draft", arguments: { expectedRevision: 4, operationId: "save-1", text: "draft" } }]);
  });

  it.each([
    { content: [{ type: "text", text: "business failure" }], isError: true, structuredContent: { code: "conflict" } },
    { content: [{ type: "text", text: '{"saved":true}' }] },
  ])("preserves the raw result without throwing, extracting, or parsing text", async result => {
    const client = createPluginAppClient({ callServerTool: async () => result });
    expect(await client.call(save, { expectedRevision: 0, operationId: "save-2", text: "draft" })).toBe(result);
  });

  it.each([
    { data: { code: "plugin_app_busy", notAccepted: true } },
    new DOMException("Cancelled", "AbortError"),
    new Error("Response lost after execution"),
  ])("keeps the original rejection and never retries an operation", async error => {
    let attempts = 0;
    const client = createPluginAppClient({ callServerTool() { attempts++; return Promise.reject(error); } });
    await expect(client.call(save, { expectedRevision: 0, operationId: "save-3", text: "draft" })).rejects.toBe(error);
    expect(attempts).toBe(1);
  });
});
