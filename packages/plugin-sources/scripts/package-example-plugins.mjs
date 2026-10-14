import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import JSZip from "jszip";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..", "..", "..");

async function readPluginFiles(zip, sourceDir, archivePath) {
  const entries = await readdir(sourceDir, { withFileTypes: true });

  if (entries.length === 0) {
    zip.folder(archivePath);
    return;
  }

  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const entryArchivePath = `${archivePath}/${entry.name}`;

    if (entry.isDirectory()) {
      await readPluginFiles(zip, sourcePath, entryArchivePath);
    } else if (entry.isFile()) {
      zip.file(entryArchivePath, await readFile(sourcePath));
    } else {
      throw new Error(`Unsupported file type in plugin source: ${sourcePath}`);
    }
  }
}

export async function packageExamplePlugins(pluginsDir, outputDir) {
  let entries;
  try {
    entries = await readdir(pluginsDir, { withFileTypes: true });
  } catch (cause) {
    throw new Error(`Unable to read example plugin directory: ${pluginsDir}`, { cause });
  }

  const plugins = entries
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  if (plugins.length === 0) {
    throw new Error(`No plugin directories found in: ${pluginsDir}`);
  }

  for (const plugin of plugins) {
    const manifestPath = join(pluginsDir, plugin.name, ".vykor-plugin", "plugin.json");
    try {
      await readFile(manifestPath);
    } catch (cause) {
      throw new Error(
        `Unable to read Native Plugin manifest for "${plugin.name}" at ${manifestPath}`,
        { cause },
      );
    }
  }

  await mkdir(outputDir, { recursive: true });

  const archives = [];
  for (const plugin of plugins) {
    const zip = new JSZip();
    await readPluginFiles(zip, join(pluginsDir, plugin.name), plugin.name);

    const archivePath = join(outputDir, `${plugin.name}.zip`);
    const archive = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await writeFile(archivePath, archive);
    archives.push(archivePath);
  }

  return archives;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const archives = await packageExamplePlugins(
      join(repositoryRoot, "examples", "plugins"),
      join(repositoryRoot, ".plugin-dist"),
    );
    for (const archive of archives) {
      console.log(`Packaged ${archive}`);
    }
  } catch (error) {
    console.error("Failed to package example plugins:", error);
    process.exitCode = 1;
  }
}
