import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadNativeAppMetadata } from "../apps.js";
import { nativeAppDefinition, writeNativeAppFixture } from "../../__test__/helpers/native-app.js";
import { validateNativePlugin } from "../../manifest/validate.js";
import { loadNativePlugin } from "../../loading/load-native-plugin.js";
import { requestedPluginPermissions } from "../../installation/installer.js";
import { PLUGIN_APP_DATA_LIMITS } from "@vykor/plugin-contracts/limits";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "vykor-app-def-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("plugin apps metadata", () => {
  it("requires declared plugin data permission and hashes exact tool policy", async () => {
    const definition = nativeAppDefinition();
    Object.assign(definition.backends[0]!, { toolPolicies: [{ tool: "SaveDocument", authorization: "plugin-data-write", maxArgumentsBytes: 1024 * 1024 }] });
    const plugin = await writeNativeAppFixture(root, definition);
    expect((await loadNativeAppMetadata(plugin)).status).toBe("invalid");
    Object.assign(plugin.manifest, { permissions: { pluginData: ["write"] } });
    const first = await loadNativeAppMetadata(plugin);
    expect(first.status).toBe("loaded");
    expect(requestedPluginPermissions(plugin.manifest)).toContain("pluginData:write");
    Object.assign(definition.backends[0]!, { toolPolicies: [{ tool: "SaveDocument", authorization: "plugin-data-write", maxArgumentsBytes: 2 * 1024 * 1024 }] });
    await writeFile(join(root, "ui/apps.json"), JSON.stringify(definition));
    expect((await loadNativeAppMetadata(plugin)).value![0]!.definitionDigest).not.toBe(first.value![0]!.definitionDigest);
  });
  it.each(["unknown-tool", "duplicate", "too-large", "wildcard", "unknown-authorization"])("rejects unsafe exact tool policy %s", async failure => {
    const definition = nativeAppDefinition();
    const policy = { tool: "SaveDocument", maxArgumentsBytes: 1024 * 1024, authorization: "plugin-data-write" };
    if (failure === "unknown-tool") policy.tool = "ForeignTool";
    if (failure === "wildcard") policy.tool = "*";
    if (failure === "too-large") policy.maxArgumentsBytes = PLUGIN_APP_DATA_LIMITS.maxArgsBytes + 1;
    if (failure === "unknown-authorization") policy.authorization = "filesystem-write";
    Object.assign(definition.backends[0]!, { toolPolicies: failure === "duplicate" ? [policy, policy] : [policy] });
    const plugin = await writeNativeAppFixture(root, definition);
    plugin.manifest.permissions = { pluginData: ["write"] };
    expect((await loadNativeAppMetadata(plugin)).status).toBe("invalid");
  });
  it("validates and loads immutable definitions without importing tool code, deriving existing UI approval", async () => {
    const plugin = await writeNativeAppFixture(root);
    plugin.manifest.permissions = { filesystem: ["write"] };
    const loaded = await loadNativeAppMetadata(plugin);
    expect(loaded.status).toBe("loaded");
    expect(Object.isFrozen(loaded.value![0]!.definition.backends[0])).toBe(true);
    expect(Object.isFrozen(loaded.value![0]!.resources)).toBe(true);
    expect(requestedPluginPermissions(plugin.manifest)).toEqual(["filesystem:write", "ui:invoke-own-tools", "ui:render"]);
    const validation = await validateNativePlugin(root);
    expect(validation.status).toBe("valid");
    expect((await loadNativePlugin(validation.plugin!)).components.apps?.value).toHaveLength(1);
  });

  it.each(["backend", "surface", "uri", "foreign-server", "args-schema", "alias", "missing-resource", "conflict"])
    ("rejects %s declarations as a whole", async failure => {
      const definition = nativeAppDefinition();
      const backend = definition.backends[0]!;
      if (backend.kind !== "native-tools") throw new Error("fixture");
      if (failure === "backend") definition.backends.push(backend);
      if (failure === "surface") definition.surfaces.push(definition.surfaces[0]!);
      if (failure === "uri") backend.resources.push(backend.resources[0]!);
      if (failure === "foreign-server") definition.backends.push({ id: "foreign", kind: "mcp-server", server: "other-plugin" });
      if (failure === "args-schema") Object.assign(backend.tools[0]!, { inputSchema: { type: "object" } });
      if (failure === "alias") Object.assign(backend.tools[0]!, { name: "OtherName" });
      if (failure === "missing-resource") definition.surfaces[0]!.resourceUri = "ui://fixture/missing.html";
      if (failure === "conflict") definition.backends.push({ ...backend, id: "other", resources: [{ uri: "ui://fixture/other.html", entry: "./ui/panel.html" }],
        tools: [{ tool: "SaveDocument", visibility: ["model"] }] });
      const plugin = await writeNativeAppFixture(root, definition);
      expect((await loadNativeAppMetadata(plugin)).status).toBe("invalid");
      expect((await validateNativePlugin(root)).status).toBe("invalid");
    });

  it("requires MCP servers to be declared by this plugin and includes declarations and resource bytes in the digest", async () => {
    const definition = nativeAppDefinition();
    definition.backends.push({ id: "notes", kind: "mcp-server", server: "notes" });
    const plugin = await writeNativeAppFixture(root, definition);
    plugin.manifest.components.mcpServers = ["./mcp.json"];
    await writeFile(join(root, "mcp.json"), JSON.stringify({ servers: { notes: { type: "stdio", command: "node" } } }));
    const first = await loadNativeAppMetadata(plugin);
    expect(first.status).toBe("loaded");
    await writeFile(join(root, "ui/apps.json"), JSON.stringify(Object.fromEntries(Object.entries(definition).reverse())));
    expect((await loadNativeAppMetadata(plugin)).value![0]!.definitionDigest).toBe(first.value![0]!.definitionDigest);
    await writeFile(join(root, "ui/panel.html"), "changed");
    expect((await loadNativeAppMetadata(plugin)).value![0]!.definitionDigest).not.toBe(first.value![0]!.definitionDigest);
  });
});
