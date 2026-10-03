import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginUiManifestV1 } from "@vykor/protocol";
import type { ValidatedNativePlugin } from "../types.js";

/** Construct files only; tests choose the real validation/load/install entry to exercise. */
export async function writeNativeUiFixture(
  root: string,
  ui: PluginUiManifestV1 = { schemaVersion: 1, components: [{
    id: "findings", title: "检查结果", entry: "./ui/findings.html",
    surfaces: ["tool-result", "session-sidebar"], actions: [],
  }] },
): Promise<ValidatedNativePlugin> {
  await mkdir(join(root, ".vykor-plugin"), { recursive: true });
  await mkdir(join(root, "ui"), { recursive: true });
  await mkdir(join(root, "tools"), { recursive: true });
  await mkdir(join(root, "skills", "check"), { recursive: true });
  const plugin: ValidatedNativePlugin = {
    root,
    manifestPath: join(root, ".vykor-plugin", "plugin.json"),
    manifest: {
      schemaVersion: 1, id: "example.ui-fixture", name: "ui-fixture", version: "1.0.0",
      components: {
        ui: ["./ui/manifest.json"], tools: ["./tools/not-executed.mjs"],
        skills: ["./skills/check/SKILL.md"],
      },
      runtime: { engine: "node", isolation: "process" },
    },
  };
  await writeFile(plugin.manifestPath, JSON.stringify(plugin.manifest));
  await writeFile(join(root, "ui", "manifest.json"), JSON.stringify(ui));
  await writeFile(join(root, "ui", "findings.html"),
    "<!doctype html><script>throw new Error('HTML must not execute during loading')</script>");
  await writeFile(join(root, "tools", "not-executed.mjs"),
    "throw new Error('Tool module must not execute during loading')");
  await writeFile(join(root, "skills", "check", "SKILL.md"),
    "---\nname: check\ndescription: UI static fixture\n---\nCheck text.");
  return plugin;
}
