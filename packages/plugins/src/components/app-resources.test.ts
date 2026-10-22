import { mkdtemp, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLUGIN_APP_RESOURCE_LIMITS } from "@vykor/plugin-contracts/limits";
import { MCP_APP_HTML_MIME_TYPE } from "@vykor/agent-contracts/tool-data";
import { writeNativeAppFixture } from "../test-helpers/native-app.js";
import { loadNativeAppMetadata } from "./apps.js";
import { readPluginAppResource } from "./app-resources.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "vykor-app-file-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("app resources", () => {
  it("returns an exact declared UI resource and rechecks immutable bytes at delivery", async () => {
    const plugin = await writeNativeAppFixture(root);
    const metadata = (await loadNativeAppMetadata(plugin)).value![0]!;
    const resource = metadata.resources[0]!;
    expect((await readPluginAppResource(root, resource)).contents).toEqual([
      { uri: "ui://fixture/panel.html", mimeType: MCP_APP_HTML_MIME_TYPE, text: "<!doctype html><p>App</p>" },
    ]);
    await writeFile(join(root, "ui/panel.html"), "changed");
    await expect(readPluginAppResource(root, resource)).rejects.toThrow("plugin_app_resource_changed");
  });

  it.each(["outside", "junction", "file-symlink", "invalid-utf8", "large-html"])("rejects %s", async failure => {
    const plugin = await writeNativeAppFixture(join(root, "plugin"));
    const definition = JSON.parse(await readFile(join(plugin.root, "ui/apps.json"), "utf8"));
    if (failure === "outside") { await writeFile(join(root, "outside.html"), "outside"); definition.backends[0].resources[0].entry = "../outside.html"; }
    if (failure === "junction") { await symlink(join(plugin.root, "ui"), join(plugin.root, "alias"), process.platform === "win32" ? "junction" : "dir"); definition.backends[0].resources[0].entry = "./alias/panel.html"; }
    if (failure === "file-symlink") { await symlink(join(plugin.root, "ui/panel.html"), join(plugin.root, "ui/link.html")); definition.backends[0].resources[0].entry = "./ui/link.html"; }
    if (failure === "invalid-utf8") await writeFile(join(plugin.root, "ui/panel.html"), Buffer.from([0xff]));
    if (failure === "large-html") await writeFile(join(plugin.root, "ui/panel.html"), Buffer.alloc(PLUGIN_APP_RESOURCE_LIMITS.htmlBytes + 1));
    await writeFile(join(plugin.root, "ui/apps.json"), JSON.stringify(definition));
    expect((await loadNativeAppMetadata(plugin)).status).toBe("invalid");
  });
});
