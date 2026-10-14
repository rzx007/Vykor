import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import JSZip from "jszip";
import { afterEach, expect, it } from "vitest";

import { packageExamplePlugins } from "../scripts/package-example-plugins.mjs";

const tempRoots: string[] = [];

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
