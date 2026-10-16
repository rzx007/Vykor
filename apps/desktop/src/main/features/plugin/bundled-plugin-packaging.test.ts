import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import JSZip from "jszip"
import { expect, it } from "vitest"
import { packageKnowledgeWorkPlugin, packageOfficeWorkPlugin } from "../../../../scripts/package-bundled-plugin"

it("packages Office with the prepared engine and excludes development files", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "vykor-office-plugin-"))
  try {
    const source = join(temporary, "source")
    for (const name of [".vykor-plugin", "tools", "test", "scripts", "bin", "licenses"]) {
      await mkdir(join(source, name), { recursive: true })
    }
    await writeFile(join(source, ".vykor-plugin/plugin.json"), '{"id":"vykor.office-work"}')
    await writeFile(join(source, "tools/index.mjs"), "export const tools = []")
    await writeFile(join(source, "tools/office-engine.mjs"), "stale generated code")
    await writeFile(join(source, "test/private.test.mjs"), "test")
    await writeFile(join(source, "scripts/build.ps1"), "build")
    await writeFile(join(source, "bin/unrelated.exe"), "stale")
    await writeFile(join(source, "licenses/OFFICECLI-LICENSE"), "license")
    const binary = join(temporary, "officecli-win-x64.exe")
    const module = join(temporary, "office-engine.mjs")
    await writeFile(binary, "verified binary")
    await writeFile(module, "shared engine")
    await packageOfficeWorkPlugin(source, join(temporary, "out"), binary, module)
    const zip = await JSZip.loadAsync(await readFile(join(temporary, "out/office-work.zip")))
    expect(Object.keys(zip.files).sort()).toEqual([
      ".vykor-plugin/plugin.json", "bin/officecli-win-x64.exe", "licenses/OFFICECLI-LICENSE",
      "tools/index.mjs", "tools/office-engine.mjs",
    ])
    expect(await zip.file("tools/office-engine.mjs")!.async("string")).toBe("shared engine")
    expect(await zip.file("bin/officecli-win-x64.exe")!.async("string")).toBe("verified binary")
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

it("packages the native manifest and supporting files into an installable ZIP", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "vykor-bundled-plugin-"))
  const source = join(temporary, "knowledge-work")
  const output = join(temporary, "out", "bundled-plugins")
  try {
    await mkdir(join(source, ".vykor-plugin"), { recursive: true })
    await mkdir(join(source, "tools"), { recursive: true })
    await writeFile(join(source, ".vykor-plugin", "plugin.json"), '{"id":"fixture"}')
    await writeFile(join(source, "tools", "index.mjs"), "export function registerTools() { return [] }")
    await packageKnowledgeWorkPlugin(source, output)
    const zip = await JSZip.loadAsync(await readFile(join(output, "knowledge-work.zip")))
    expect(Object.keys(zip.files).filter(name => !zip.files[name]!.dir).sort()).toEqual([
      ".vykor-plugin/plugin.json", "tools/index.mjs",
    ])
    expect(await zip.file(".vykor-plugin/plugin.json")!.async("string")).toBe('{"id":"fixture"}')
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
