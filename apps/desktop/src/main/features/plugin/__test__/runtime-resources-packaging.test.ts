import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import type { Configuration } from "electron-builder"
import { parse } from "yaml"
import { expect, it } from "vitest"

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve("electron-builder/package.json"))
const { getFileMatchers, copyFiles } = builderRequire("app-builder-lib/out/fileMatcher") as {
  getFileMatchers(
    config: Configuration,
    name: "files" | "extraResources",
    destination: string,
    options: {
      macroExpander: (value: string) => string
      customBuildOptions: object
      globalOutDir: string
      defaultSrc: string
    }
  ): unknown[] | null
  copyFiles(matchers: unknown[] | null): Promise<void>
}

it("packages the host engine and application without stale bundled plugin archives", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "vykor-desktop-resources-"))
  const source = join(temporary, "desktop")
  const resources = join(temporary, "resources")
  try {
    for (const path of [
      "out/main/index.js",
      "out/office-engine/officecli-win-x64.exe",
      "out/office-engine/OFFICECLI-LICENSE",
      "out/bundled-plugins/knowledge-work.zip",
      "out/bundled-plugins/office-work.zip",
    ]) {
      await mkdir(dirname(join(source, path)), { recursive: true })
      await writeFile(join(source, path), path)
    }
    const config = parse(
      await readFile(
        fileURLToPath(new URL("../../../../../electron-builder.yml", import.meta.url)),
        "utf8"
      )
    ) as Configuration
    const options = {
      macroExpander: (value: string) => value,
      customBuildOptions: {},
      globalOutDir: join(source, "dist"),
      defaultSrc: source,
    }
    await copyFiles(getFileMatchers(config, "files", join(resources, "app"), options))
    await copyFiles(getFileMatchers(config, "extraResources", resources, options))

    const files = (await readdir(resources, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => relative(resources, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
      .sort()
    expect(files).toEqual([
      "app/out/main/index.js",
      "office-engine/OFFICECLI-LICENSE",
      "office-engine/officecli-win-x64.exe",
    ])
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
