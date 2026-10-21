import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginAppManifest } from "@vykor/protocol";
import type { ValidatedNativePlugin } from "../types.js";

export function nativeAppDefinition(): PluginAppManifest {
  return { schemaVersion: 1, backends: [{ id: "editor", kind: "native-tools",
    resources: [{ uri: "ui://fixture/panel.html", entry: "./ui/panel.html" }],
    tools: [{ tool: "SaveDocument", visibility: ["app"], ui: { resourceUri: "ui://fixture/panel.html" } }],
  }], surfaces: [{ id: "editor", title: "Editor", backend: "editor", resourceUri: "ui://fixture/panel.html", availability: "session" }] };
}

export async function writeNativeAppFixture(root: string, definition = nativeAppDefinition()): Promise<ValidatedNativePlugin> {
  for (const dir of [".vykor-plugin", "ui", "tools"]) await mkdir(join(root, dir), { recursive: true });
  const plugin: ValidatedNativePlugin = { root, manifestPath: join(root, ".vykor-plugin/plugin.json"), manifest: {
    schemaVersion: 1, id: "example.app-fixture", name: "app-fixture", version: "1.0.0",
    components: { apps: ["./ui/apps.json"], tools: ["./tools/index.mjs"] },
  } };
  await writeFile(plugin.manifestPath, JSON.stringify(plugin.manifest));
  await writeFile(join(root, "ui/apps.json"), JSON.stringify(definition));
  await writeFile(join(root, "ui/panel.html"), "<!doctype html><p>App</p>");
  await writeFile(join(root, "tools/index.mjs"), "throw new Error('must not import during metadata load')");
  return plugin;
}
