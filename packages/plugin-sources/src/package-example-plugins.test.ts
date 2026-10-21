import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import JSZip from "jszip";
import { afterEach, expect, it } from "vitest";

import { packageExamplePlugins } from "../scripts/package-example-plugins.mjs";

const tempRoots: string[] = [];
it("runs the actual packaged inspector outside the repository without install/build dependencies", async () => {
  const { pluginsDir, outputDir } = await createFixture();
  await cp(fileURLToPath(new URL("../../../examples/plugins/text-inspector/", import.meta.url)), join(pluginsDir, "text-inspector"),
    { recursive: true, filter: path => !path.split(/[\\/]/).includes("node_modules") });
  await packageExamplePlugins(pluginsDir, outputDir);
  const zip = await JSZip.loadAsync(await readFile(join(outputDir, "text-inspector.zip")));
  expect(Object.keys(zip.files).some(name => name.includes("node_modules") || name.endsWith("/sdk.js"))).toBe(false);
  const extracted = join(outputDir, "extracted");
  for (const [name, entry] of Object.entries(zip.files)) if (!entry.dir) {
    const path = join(extracted, name);
    await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, await entry.async("nodebuffer"));
  }
  const plugin = join(extracted, "text-inspector");
  const script = "import {registerTools} from './tools/index.mjs';const r=registerTools().find(t=>t.name==='TextInspectorPreview').invoke({text:'ok  ',selected:['1:trailing-whitespace']});if(r.metadata.appData.text!=='ok')throw Error('preview');console.log('offline native preview passed')";
  const ran = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: plugin, encoding: "utf8" });
  expect(ran.status, ran.stderr).toBe(0);
  const html = await readFile(join(plugin, "ui/panel.html"), "utf8");
  expect(html).not.toMatch(/<(?:script|link|iframe)\b[^>]*(?:src|href)=/i);
  expect(html).not.toContain("VykorPluginUi");
});

async function createFixture(): Promise<{ pluginsDir: string; outputDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "vykor-example-plugins-"));
  tempRoots.push(root);
  return {
    pluginsDir: join(root, "plugins"),
    outputDir: join(root, "dist"),
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function addPlugin(pluginsDir: string, name: string): Promise<void> {
  const pluginDir = join(pluginsDir, name);
  await mkdir(join(pluginDir, ".vykor-plugin"), { recursive: true });
  await writeFile(join(pluginDir, ".vykor-plugin", "plugin.json"), JSON.stringify({ id: name }));
  await writeFile(join(pluginDir, "README.md"), `# ${name}`);
}

it("packages every plugin with its top-level folder and hidden manifest", async () => {
  const { pluginsDir, outputDir } = await createFixture();
  await addPlugin(pluginsDir, "alpha");
  await addPlugin(pluginsDir, "beta");

  const archives = await packageExamplePlugins(pluginsDir, outputDir);

  expect(archives.map((archive) => basename(archive))).toEqual(["alpha.zip", "beta.zip"]);
  const zip = await JSZip.loadAsync(await readFile(join(outputDir, "alpha.zip")));
  expect(zip.file("alpha/.vykor-plugin/plugin.json")).not.toBeNull();
  expect(zip.file("alpha/README.md")).not.toBeNull();
});

it("overwrites its own archive and leaves unrelated output files alone", async () => {
  const { pluginsDir, outputDir } = await createFixture();
  await addPlugin(pluginsDir, "alpha");
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "alpha.zip"), "old archive");
  await writeFile(join(outputDir, "keep.txt"), "keep");

  await packageExamplePlugins(pluginsDir, outputDir);

  expect(await readFile(join(outputDir, "keep.txt"), "utf8")).toBe("keep");
  const zip = await JSZip.loadAsync(await readFile(join(outputDir, "alpha.zip")));
  expect(zip.file("alpha/README.md")).not.toBeNull();
});

it("fails when a direct child directory has no Native Plugin manifest", async () => {
  const { pluginsDir, outputDir } = await createFixture();
  await mkdir(join(pluginsDir, "not-a-plugin"), { recursive: true });

  await expect(packageExamplePlugins(pluginsDir, outputDir))
    .rejects.toThrow(/not-a-plugin.*plugin\.json/i);
});
