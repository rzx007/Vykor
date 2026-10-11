import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import JSZip from "jszip"
import { expect, it } from "vitest"
import { packageKnowledgeWorkPlugin } from "../../../../scripts/package-bundled-plugin"

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
