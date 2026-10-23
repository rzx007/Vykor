import { type ToolDefinition } from "@vykor/agent-contracts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "@vykor/core";
import { McpClientManager } from "@vykor/mcp";
import type { NativeAppMetadata } from "@vykor/plugins";
import { captureMcpPluginAppBackend, mcpToolResultToAppResult } from "../mcp-plugin-app-backend.js";
import { createVisibilityToolRegistry, getTrustedToolCatalogue } from "../../tools/default-runtime-tools.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const definition = { id: "notes", kind: "mcp-server" as const, server: "notes" };
const metadata: NativeAppMetadata = { declaredManifest: "./ui/apps.json", definitionDigest: "definition-digest", resources: [],
  definition: { schemaVersion: 1, backends: [definition], surfaces: [
    { id: "notes", title: "Notes", backend: "notes", resourceUri: "ui://notes/panel.html", availability: "session" },
  ] } };

async function connect() {
  const root = await mkdtemp(join(tmpdir(), "vykor-mcp-app-")); roots.push(root);
  const entry = join(root, "server.mjs");
  await writeFile(entry, `
    import { createInterface } from "node:readline";
    let calls = 0;
    const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
    createInterface({ input: process.stdin }).on("line", line => {
      const request = JSON.parse(line); if (request.id === undefined) return;
      switch (request.method) {
        case "initialize": return send(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "notes", version: "1" } });
        case "tools/list": return send(request.id, { tools: [{ name: "save", description: "save", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["app"] } } }] });
        case "resources/list": return send(request.id, { resources: [{ uri: "ui://notes/panel.html", name: "panel", mimeType: "text/html;profile=mcp-app" }] });
        case "resources/templates/list": return send(request.id, { resourceTemplates: [] });
        case "resources/read": return send(request.id, { contents: [{ uri: request.params.uri, mimeType: "text/html;profile=mcp-app", text: "<!doctype html><p>Notes</p>" }] });
        case "tools/call": calls++; return send(request.id, { content: [{ type: "text", text: "Saved" }], structuredContent: { calls }, _meta: { private: "page only" } });
        default: return send(request.id, {});
      }
    });
  `);
  const manager = new McpClientManager({ cwd: root });
  const registry = new ToolRegistry();
  let installedTools: ToolDefinition[] = [];
  const prepared = await manager.prepareConnection("notes", { type: "stdio", command: process.execPath, args: [entry] });
  const activation = manager.activatePreparedConnection(prepared, tools => {
    installedTools = tools.map((tool): ToolDefinition => ({ ...tool, execution: { domain: "control_plane", supportedEnvironments: ["local"], network: true } }));
    registry.replaceBySource({ kind: "mcp", id: "notes" }, installedTools);
  });
  expect(activation.committed).toBe(true);
  const resources = manager.captureAppResources("notes")!;
  const capture = (toolRegistry = getTrustedToolCatalogue(createVisibilityToolRegistry(registry, { kind: "all" }, new Set()))) =>
    captureMcpPluginAppBackend({ pluginId: "example.notes", pluginVersion: "1", pluginDigest: "digest", metadata, definition,
      serverId: "plugin:notes", resources, installedTools, toolRegistry });
  return { manager, registry, installedTools, resources, capture };
}

describe("MCP app captured generation", () => {
  it("uses the exact installed binding once and preserves raw page data, with resource-only access to the original client", async () => {
    const { manager, registry, installedTools, capture } = await connect();
    try {
      const backend = capture();
      expect([...backend.tools.keys()]).toEqual(["save"]);
      expect(backend.tools.get("save")!.definition.execute).toBe(installedTools[0]!.execute);
      expect(backend.tools.get("save")!.definition.name).toBe("mcp__notes__save");
      expect(backend.isCurrentTool("save")).toBe(true);
      expect(backend.port).not.toHaveProperty("invoke");
      expect((await backend.port.readResource("ui://notes/panel.html")).contents[0]).toMatchObject({ text: "<!doctype html><p>Notes</p>" });
      expect((await backend.port.listResources()).resources).toHaveLength(1);
      expect(await backend.port.listResourceTemplates()).toEqual({ resourceTemplates: [] });
      const original = await backend.tools.get("save")!.invoke({}, { cwd: "." });
      expect(original.executionState).toBe("completed");
      expect(mcpToolResultToAppResult(original).result).toMatchObject({ structuredContent: { calls: 1 }, _meta: { private: "page only" } });
      // A fresh equivalent closure is a different binding and is never accepted as the installed definition.
      const fresh = manager.getAsToolDefinitions();
      expect(fresh[0]!.execute).not.toBe(installedTools[0]!.execute);
      registry.replaceBySource({ kind: "mcp", id: "notes" }, fresh);
      expect(backend.isCurrentTool("save")).toBe(false);
      expect(capture().tools.size).toBe(0);
      await manager.disconnect("notes");
      expect(backend.port.isCurrent()).toBe(false);
      await expect(backend.port.readResource("ui://notes/panel.html")).rejects.toThrow("backend_changed");
    } finally { await manager.disconnectAll(); }
  }, 20_000);

  it("applies host/role/deny/environment/network ceilings to private app tools before any client call", async () => {
    const { manager, registry, capture } = await connect();
    try {
      const original = registry.get("mcp__notes__save")!;
      const call = vi.spyOn(original, "execute");
      for (const [ceiling, deny, environment] of [
        [{ kind: "none" }, new Set<string>(), undefined],
        [{ kind: "only", names: new Set(["other"]) }, new Set<string>(), undefined],
        [{ kind: "all" }, new Set(["mcp__notes__save"]), undefined],
        [{ kind: "all" }, new Set<string>(), { info: { kind: "wsl", networkMode: "host" } }],
        [{ kind: "all" }, new Set<string>(), { info: { kind: "local", networkMode: "none" } }],
      ] as const) {
        const limited = createVisibilityToolRegistry(registry, ceiling, deny, environment as Parameters<typeof createVisibilityToolRegistry>[3]);
        expect(capture(getTrustedToolCatalogue(limited)).tools.size).toBe(0);
        expect(limited.getAll()).toEqual([]);
      }
      expect(call).not.toHaveBeenCalled();
      const permitted = capture();
      expect(mcpToolResultToAppResult(await permitted.tools.get("save")!.invoke({}, { cwd: "." })).result.structuredContent).toEqual({ calls: 1 });
      expect(call).toHaveBeenCalledTimes(1);
    } finally { await manager.disconnectAll(); }
  }, 20_000);

  it("invalidates old resources on replacement, even when the server name and registry are unchanged", async () => {
    const { manager, capture } = await connect();
    try {
      const backend = capture();
      const config = manager.getConnection("notes")!.config;
      const replacement = await manager.prepareConnection("notes", config);
      const activated = manager.activatePreparedConnection(replacement, () => {});
      expect(activated.committed).toBe(true);
      expect(backend.port.isCurrent()).toBe(false);
      expect(manager.captureAppResources("notes")!.generation).not.toBe(backend.port.generation);
      await expect(backend.port.listResources()).rejects.toThrow("backend_changed");
      if (activated.committed) await activated.closePrevious();
    } finally { await manager.disconnectAll(); }
  }, 20_000);
});
