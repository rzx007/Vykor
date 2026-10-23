import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it, vi } from "vitest";
import { PLUGIN_APP_RESOURCE_LIMITS } from "@vykor/plugin-contracts/limits";
import { MCP_APP_HTML_MIME_TYPE } from "@vykor/agent-contracts/tool-data";
import { captureMcpAppResources } from "../app-resources.js";

describe("generation-bound MCP app resources", () => {
  const uri = "ui://app/panel.html";
  function fixture(contents: unknown[]) {
    const readResource = vi.fn(async () => ({ contents }));
    const listResources = vi.fn(async () => ({ resources: [] }));
    const client = { readResource, listResources, listResourceTemplates: vi.fn(async () => ({ resourceTemplates: [] })),
      getServerCapabilities: () => ({ resources: {} }) } as unknown as Client;
    let current = true;
    const port = captureMcpAppResources(client, "original", () => current);
    return { port, readResource, listResources, invalidate: () => { current = false; } };
  }

  it.each(["decoded-total", "html", "malformed-base64", "foreign-uri"])("rejects %s without silent truncation", async failure => {
    const contents = failure === "decoded-total" ? [
      { uri, blob: Buffer.alloc(PLUGIN_APP_RESOURCE_LIMITS.resourceBytes / 2 + 1).toString("base64") },
      { uri, blob: Buffer.alloc(PLUGIN_APP_RESOURCE_LIMITS.resourceBytes / 2 + 1).toString("base64") },
    ] : failure === "html" ? [{ uri, mimeType: MCP_APP_HTML_MIME_TYPE, text: "x".repeat(PLUGIN_APP_RESOURCE_LIMITS.htmlBytes + 1) }]
      : failure === "malformed-base64" ? [{ uri, blob: "%%%" }] : [{ uri: "ui://other/panel.html", text: "wrong" }];
    const { port, readResource } = fixture(contents);
    await expect(port.readResource(uri)).rejects.toThrow(failure === "foreign-uri" ? "uri_mismatch" : failure === "malformed-base64" ? "invalid_blob" : "too_large");
    expect(readResource).toHaveBeenCalledTimes(1);
  });

  it("rejects late resource success from an invalidated generation and never contacts a replacement", async () => {
    const { port, readResource, invalidate } = fixture([]);
    let complete!: (result: { contents: unknown[] }) => void;
    readResource.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const pending = port.readResource(uri);
    const rejected = expect(pending).rejects.toThrow("backend_changed");
    invalidate();
    complete({ contents: [{ uri, text: "late" }] });
    await rejected;
    await expect(port.readResource(uri)).rejects.toThrow("backend_changed");
    expect(readResource).toHaveBeenCalledTimes(1);
  });

  it("does not claim Native-like empty successful resource support for a stale backend", async () => {
    const { port, listResources, invalidate } = fixture([]);
    invalidate();
    await expect(port.listResourceTemplates()).rejects.toThrow("backend_changed");
    await expect(port.listResources()).rejects.toThrow("backend_changed");
    expect(listResources).not.toHaveBeenCalled();
  });
});
