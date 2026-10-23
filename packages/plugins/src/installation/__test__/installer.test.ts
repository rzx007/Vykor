import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installLocalNativePlugin, requestedPluginPermissions } from "../installer.js";
import { writeNativeAppFixture } from "../../__test__/helpers/native-app.js";
import { readInstalledPluginStore, updateInstalledPluginStore } from "../store.js";

const fixture = fileURLToPath(new URL("../../../fixtures/native-v1/minimal-skill", import.meta.url));
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "vk-plugin-install-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("installLocalNativePlugin", () => {
  it("rechecks reused approval under the install lock rather than silently granting revoked permissions", async () => {
    const sourcePath = join(root, "approval-race"); await writeNativeAppFixture(sourcePath);
    const input = { sourcePath, scope: "user" as const, cwd: root, approvedPermissions: ["ui:invoke-own-tools", "ui:render"], cacheDir: join(root, "cache"), storePath: join(root, "installed.json") };
    const first = await installLocalNativePlugin(input); if (first.status !== "installed") throw new Error("fixture install failed");
    await updateInstalledPluginStore(input.storePath, store => { store.plugins[`user::${first.record.id}`]!.approvedPermissions = []; });
    expect((await installLocalNativePlugin({ ...input, reuseApprovedPermissions: true })).status).toBe("blocked");
  });
  it("commits provenance and receipt atomically, and requires explicit confirmation to detach the source", async () => {
    const input = { sourcePath: fixture, scope: "user" as const, cwd: root, approvedPermissions: [], cacheDir: join(root, "cache"), storePath: join(root, "installed.json") };
    const provenance = { sourceId: "official", catalogUrl: "https://example.com/marketplace.json", version: "1.0.0", archiveDigest: "a".repeat(64), repository: "https://github.com/example/plugins", commit: "b".repeat(40), path: "plugin" };
    const operation = { operationId: "test-operation", fingerprint: "fixed-request", status: "installed" as const, pluginId: "dev.vykor.minimal-skill", version: "1.0.0", message: "installed", updatedAt: new Date().toISOString() };
    expect((await installLocalNativePlugin({ ...input, provenance, operation })).status).toBe("installed");
    const stored = await readInstalledPluginStore(input.storePath);
    expect(stored.plugins["user::dev.vykor.minimal-skill"]?.provenance).toEqual(provenance);
    expect(stored.installOperations?.[operation.operationId]?.status).toBe("installed");
    const rejected = await installLocalNativePlugin(input); expect(rejected.status).toBe("blocked");
    expect((await readInstalledPluginStore(input.storePath)).revision).toBe(stored.revision);
    expect((await installLocalNativePlugin({ ...input, allowSourceChange: true })).status).toBe("installed");
    expect((await readInstalledPluginStore(input.storePath)).plugins["user::dev.vykor.minimal-skill"]?.provenance).toBeUndefined();
  });
  it("requires explicit plugin data write approval before publishing an installed app", async () => {
    const sourcePath = join(root, "autosave");
    const plugin = await writeNativeAppFixture(sourcePath);
    plugin.manifest.permissions = { pluginData: ["write"] };
    await writeFile(plugin.manifestPath, JSON.stringify(plugin.manifest));
    const input = { sourcePath, scope: "user" as const, cwd: root, cacheDir: join(root, "cache"), storePath: join(root, "installed.json") };
    expect((await installLocalNativePlugin({ ...input, approvedPermissions: ["ui:render", "ui:invoke-own-tools"] })).status).toBe("blocked");
    expect((await readInstalledPluginStore(input.storePath)).plugins).toEqual({});
    const installed = await installLocalNativePlugin({ ...input, approvedPermissions: ["ui:render", "ui:invoke-own-tools", "pluginData:write"] });
    expect(installed.status).toBe("installed");
  });
  it("requires both inferred App permissions and never executes the plugin", async () => {
    const sourcePath = join(root, "source");
    const plugin = await writeNativeAppFixture(sourcePath);
    expect(requestedPluginPermissions(plugin.manifest)).toEqual(["ui:invoke-own-tools", "ui:render"]);
    const input = { sourcePath, scope: "user" as const, cwd: root,
      cacheDir: join(root, "cache"), storePath: join(root, "installed.json") };
    expect((await installLocalNativePlugin({ ...input, approvedPermissions: [] })).status).toBe("blocked");
    expect((await readInstalledPluginStore(input.storePath)).plugins).toEqual({});
    const installed = await installLocalNativePlugin({ ...input,
      approvedPermissions: ["ui:invoke-own-tools", "ui:render"] });
    expect(installed.status).toBe("installed");
    if (installed.status !== "installed") throw new Error("expected installed App fixture");
    expect(installed.record.requestedPermissions).toEqual(["ui:invoke-own-tools", "ui:render"]);
  });

  it("rejects broken App without publishing an installed record or snapshot", async () => {
    const sourcePath = join(root, "source");
    await writeNativeAppFixture(sourcePath);
    await writeFile(join(sourcePath, "ui", "apps.json"), "{");
    const input = { sourcePath, scope: "user" as const, cwd: root,
      cacheDir: join(root, "cache"), storePath: join(root, "installed.json"),
      approvedPermissions: ["ui:invoke-own-tools", "ui:render"] };
    expect((await installLocalNativePlugin(input)).status).toBe("invalid");
    expect((await readInstalledPluginStore(input.storePath)).plugins).toEqual({});
    expect(await readdir(input.cacheDir).catch(() => [])).toEqual([]);
  });
  it("validates, copies, validates again, then updates installed state", async () => {
    const result = await installLocalNativePlugin({
      sourcePath: fixture, scope: "user", cwd: root, approvedPermissions: [],
      cacheDir: join(root, "cache"), storePath: join(root, "installed.json"),
    });
    expect(result.status).toBe("installed");
    const store = await readInstalledPluginStore(join(root, "installed.json"));
    const record = Object.values(store.plugins)[0];
    expect(record?.id).toBe("dev.vykor.minimal-skill");
    expect(record?.cachePath).toBe(join(root, "cache", "dev.vykor.minimal-skill", `1.0.0-${record?.behaviorDigest}`));
    expect((record as { behaviorDigest?: string } | undefined)?.behaviorDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await readdir(join(root, "cache", "dev.vykor.minimal-skill"))).toEqual([`1.0.0-${record?.behaviorDigest}`]);
  });

  it("preserves enabled state and installedAt when reinstalling the same user plugin", async () => {
    const storePath = join(root, "installed.json");
    const cacheDir = join(root, "cache");
    const first = await installLocalNativePlugin({
      sourcePath: fixture,
      scope: "user",
      cwd: root,
      approvedPermissions: [],
      cacheDir,
      storePath,
    });
    expect(first.status).toBe("installed");
    if (first.status !== "installed") throw new Error("expected first install");

    await updateInstalledPluginStore(storePath, (store) => {
      const record = store.plugins[`user::${first.record.id}`]!;
      record.enabled = false;
      record.installedAt = "2026-01-01T00:00:00.000Z";
      record.updatedAt = "2026-01-01T00:00:00.000Z";
    });

    const second = await installLocalNativePlugin({
      sourcePath: fixture,
      scope: "user",
      cwd: root,
      approvedPermissions: [],
      cacheDir,
      storePath,
    });
    expect(second.status).toBe("installed");
    if (second.status !== "installed") throw new Error("expected reinstall");

    const record = (await readInstalledPluginStore(storePath)).plugins[`user::${first.record.id}`]!;
    expect(record.enabled).toBe(false);
    expect(record.installedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(record.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
    expect(second.record).toEqual(record);
  });

  it.each(["project", "local"] as const)("rejects the legacy %s installation scope", async (scope) => {
    const result = await installLocalNativePlugin({
      sourcePath: fixture,
      scope,
      cwd: root,
      approvedPermissions: [],
      cacheDir: join(root, "cache"),
      storePath: join(root, "installed.json"),
    } as unknown as Parameters<typeof installLocalNativePlugin>[0]);

    expect(result).toEqual({
      status: "blocked",
      diagnostics: [{
        severity: "error",
        phase: "install",
        code: "plugin_scope_not_supported",
        message: `Native Plugins can only be installed for the user; received scope '${scope}'`,
      }],
    });
    expect((await readInstalledPluginStore(join(root, "installed.json"))).plugins).toEqual({});
  });

  it("records converted origin from Native manifest metadata without conversion side files", async () => {
    const source = join(root, "converted-native");
    await mkdir(join(source, ".vykor-plugin"), { recursive: true });
    await mkdir(join(source, "skills", "metadata-only"), { recursive: true });
    await writeFile(join(source, "skills", "metadata-only", "SKILL.md"), [
      "---",
      "name: metadata-only",
      "description: Metadata-only converted plugin fixture",
      "---",
      "Use the fixture.",
    ].join("\n"));
    await writeFile(join(source, ".vykor-plugin", "plugin.json"), JSON.stringify({
      schemaVersion: 1,
      id: "converted.claude.metadata-only",
      name: "metadata-only",
      version: "1.0.0",
      metadata: {
        origin: "converted",
        sourceFormat: "claude-code",
        converterId: "claude-code",
        converterVersion: "1.0.0",
      },
      components: { skills: ["./skills"] },
    }));

    const result = await installLocalNativePlugin({
      sourcePath: source,
      scope: "user",
      cwd: root,
      approvedPermissions: [],
      cacheDir: join(root, "cache"),
      storePath: join(root, "installed.json"),
    });

    expect(result.status).toBe("installed");
    if (result.status !== "installed") return;
    expect(result.record.origin).toBe("converted");
    expect(result.record.sourceFormat).toBe("claude-code");
  });
});
