import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeNativeUiFixture } from "../test-helpers/native-ui.js";
import { loadNativeUiMetadata, summarizeNativeUi } from "./ui.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "vk-ui-metadata-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("loadNativeUiMetadata", () => {
  it("loads files and hashes without executing HTML or Node", async () => {
    const plugin = await writeNativeUiFixture(root);
    const loaded = await loadNativeUiMetadata(plugin);
    expect(loaded.status).toBe("loaded");
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.value).toHaveLength(1);
    expect(loaded.value![0]).toMatchObject({
      declaredManifest: "./ui/manifest.json", declaredEntry: "./ui/findings.html",
      definition: { id: "findings", actions: [] },
    });
    expect(loaded.value![0]!.htmlSha256).toBe(createHash("sha256")
      .update(await readFile(join(root, "ui", "findings.html"))).digest("hex"));
    expect(loaded.value![0]!.componentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(summarizeNativeUi(1, loaded)).toEqual({ manifestCount: 1, componentCount: 1, validatedComponentCount: 1 });
    expect(summarizeNativeUi(0, undefined)).toBeUndefined();
    expect(summarizeNativeUi(1, undefined)).toEqual({ manifestCount: 1, componentCount: null, validatedComponentCount: 0 });
  });

  it("hashes the entire definition but ignores JSON property order", async () => {
    const plugin = await writeNativeUiFixture(root);
    const first = await loadNativeUiMetadata(plugin);
    const ui = JSON.parse(await readFile(join(root, "ui", "manifest.json"), "utf8"));
    const definition = ui.components[0];
    ui.components[0] = Object.fromEntries(Object.entries(definition).reverse());
    await writeFile(join(root, "ui", "manifest.json"), JSON.stringify(ui));
    expect((await loadNativeUiMetadata(plugin)).value![0]!.componentDigest).toBe(first.value![0]!.componentDigest);
    for (const patch of [
      { title: "Changed" },
      { surfaces: ["tool-result"] },
      { actions: [{ id: "explain", label: "Explain", tool: "TextInspectorExplain", completion: "keep-open" }] },
    ]) {
      ui.components[0] = { ...definition, ...patch };
      await writeFile(join(root, "ui", "manifest.json"), JSON.stringify(ui));
      const changed = await loadNativeUiMetadata(plugin);
      expect(changed.value![0]!.componentDigest).not.toBe(first.value![0]!.componentDigest);
      expect(changed.value![0]!.htmlSha256).toBe(first.value![0]!.htmlSha256);
    }
    await writeFile(join(root, "ui", "findings.html"), "<!doctype html><p>Changed</p>");
    expect((await loadNativeUiMetadata(plugin)).value![0]!.htmlSha256).not.toBe(first.value![0]!.htmlSha256);
  });

  it.each(["missing", "directory", "outside", "bad-json", "bad-utf8", "large-html", "large-json"])
    ("rejects %s without exposing file contents or absolute paths", async kind => {
      const plugin = await writeNativeUiFixture(join(root, "plugin"));
      const manifestPath = join(plugin.root, "ui", "manifest.json");
      const htmlPath = join(plugin.root, "ui", "findings.html");
      if (kind === "missing") await rm(htmlPath);
      if (kind === "directory") { await rm(htmlPath); await mkdir(htmlPath); }
      if (kind === "outside") {
        const ui = JSON.parse(await readFile(manifestPath, "utf8"));
        ui.components[0].entry = "./../secret.html";
        await writeFile(join(root, "secret.html"), "PRIVATE CONTENT");
        await writeFile(manifestPath, JSON.stringify(ui));
      }
      if (kind === "bad-json") await writeFile(manifestPath, "{");
      if (kind === "bad-utf8") await writeFile(htmlPath, Buffer.from([0xff]));
      if (kind === "large-html") await writeFile(htmlPath, Buffer.alloc(2 * 1024 * 1024 + 1, 65));
      if (kind === "large-json") await writeFile(manifestPath, Buffer.alloc(256 * 1024 + 1, 65));
      const loaded = await loadNativeUiMetadata(plugin);
      expect(loaded.status).toBe("invalid");
      expect(loaded.value).toBeUndefined();
      expect(loaded.diagnostics[0]?.code).toBe(kind.startsWith("large-")
        ? "plugin_ui_payload_too_large" : "plugin_ui_invalid_definition");
      expect(JSON.stringify(loaded.diagnostics)).not.toContain(root);
      expect(JSON.stringify(loaded.diagnostics)).not.toContain("PRIVATE CONTENT");
    });

  it("rejects a directory junction even when its target is inside the plugin", async () => {
    const plugin = await writeNativeUiFixture(root);
    await symlink(join(root, "ui"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    const ui = JSON.parse(await readFile(join(root, "ui", "manifest.json"), "utf8"));
    ui.components[0].entry = "./alias/findings.html";
    await writeFile(join(root, "ui", "manifest.json"), JSON.stringify(ui));
    expect((await loadNativeUiMetadata(plugin)).status).toBe("invalid");
    plugin.manifest.components.ui = ["./alias/manifest.json"];
    expect((await loadNativeUiMetadata(plugin)).status).toBe("invalid");
  });

  it("rejects an in-root file symlink", async ({ skip }) => {
    const plugin = await writeNativeUiFixture(root);
    try {
      await symlink(join(root, "ui", "findings.html"), join(root, "ui", "linked.html"), "file");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        skip();
        return;
      }
      throw error;
    }
    const ui = JSON.parse(await readFile(join(root, "ui", "manifest.json"), "utf8"));
    ui.components[0].entry = "./ui/linked.html";
    await writeFile(join(root, "ui", "manifest.json"), JSON.stringify(ui));
    expect((await loadNativeUiMetadata(plugin)).status).toBe("invalid");
  });

  it("rejects cross-manifest duplicates and more than sixteen components", async () => {
    const plugin = await writeNativeUiFixture(root);
    const initial = JSON.parse(await readFile(join(root, "ui", "manifest.json"), "utf8"));
    await writeFile(join(root, "ui", "second.json"), JSON.stringify(initial));
    plugin.manifest.components.ui!.push("./ui/second.json");
    expect((await loadNativeUiMetadata(plugin)).status).toBe("invalid");
    initial.components = Array.from({ length: 16 }, (_, i) => ({ ...initial.components[0], id: `component-${i}` }));
    await writeFile(join(root, "ui", "manifest.json"), JSON.stringify(initial));
    await writeFile(join(root, "ui", "second.json"), JSON.stringify({ schemaVersion: 1,
      components: [{ ...initial.components[0], id: "extra" }],
    }));
    expect((await loadNativeUiMetadata(plugin)).status).toBe("invalid");
  });

  it("accepts exact byte limits and shared HTML entries", async () => {
    const plugin = await writeNativeUiFixture(root);
    const ui = JSON.parse(await readFile(join(root, "ui", "manifest.json"), "utf8"));
    ui.components.push({ ...ui.components[0], id: "second" });
    const source = JSON.stringify(ui);
    await writeFile(join(root, "ui", "manifest.json"), source + " ".repeat(256 * 1024 - Buffer.byteLength(source)));
    await writeFile(join(root, "ui", "findings.html"), Buffer.alloc(2 * 1024 * 1024, 65));
    expect((await loadNativeUiMetadata(plugin)).value).toHaveLength(2);
  });
});
