import { readdirSync, existsSync } from "node:fs"
import { join, relative, basename, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = fileURLToPath(new URL("../", import.meta.url))

function collect(directory: string): { files: string[]; categories: string[] } {
  const files: string[] = []
  const categories: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (!entry.isDirectory()) {
      files.push(path)
      continue
    }
    const nested = collect(path)
    files.push(...nested.files)
    if (entry.name !== "__test__") categories.push(path, ...nested.categories)
  }
  return { files, categories }
}

describe("desktop directory conventions", () => {
  it("documents every feature category and keeps loose code out of the root", () => {
    const { categories } = collect(root)
    const undocumented = [root, ...categories].filter(
      (directory) => !existsSync(join(directory, "README.md"))
    )
    expect(undocumented.map((path) => relative(root, path))).toEqual([])
    expect(readdirSync(root).filter((name) => /\.(?:tsx?|css)$/.test(name))).toEqual([])
  })

  it("keeps tests, benchmarks and test support inside __test__", () => {
    const { files } = collect(root)
    const misplaced = files.filter((path) => {
      const name = basename(path)
      if (/\.(?:test|bench)\.tsx?$/.test(name)) return basename(dirname(path)) !== "__test__"
      return (
        name.endsWith(".test-support.ts") &&
        !relative(root, path).split(/[\\/]/).includes("__test__")
      )
    })
    expect(misplaced.map((path) => relative(root, path))).toEqual([])
  })
})
