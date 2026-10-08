import { mkdtemp, writeFile, rm, truncate } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { DesktopSessionPart } from "@shared/session-types"
import { readToolImagePreview } from "./read-tool-image-preview"

const directories: string[] = []
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")
function part(path: string, overrides: Record<string, unknown> = {}): DesktopSessionPart {
  return { type: "tool", toolName: "Read", status: "completed", output: {
    content: [{ type: "image", source: { type: "file", path, mediaType: "image/png" } }],
  }, ...overrides } as DesktopSessionPart
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
describe("readToolImagePreview", () => {
  it("reads only the image source recorded by a completed Read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "read-preview-")); directories.push(directory)
    const path = join(directory, "image.png"); await writeFile(path, png)
    const preview = await readToolImagePreview(part(path))
    expect(preview.mediaType).toBe("image/png")
    expect(Buffer.from(preview.bytes)).toEqual(png)
  })
  it.each([{ toolName: "Shell" }, { status: "running" }, { isError: true }, { output: { isError: true } }])("rejects a record outside successful Read results: %j", async overrides => {
    await expect(readToolImagePreview(part("missing.png", overrides))).rejects.toThrow("成功读取")
  })
  it("rejects text results and invalid image bytes", async () => {
    await expect(readToolImagePreview(part("missing.png", { output: { content: [{ type: "text", text: "hello" }] } }))).rejects.toThrow("图片")
    const directory = await mkdtemp(join(tmpdir(), "read-preview-")); directories.push(directory)
    const path = join(directory, "image.png"); await writeFile(path, "not an image")
    await expect(readToolImagePreview(part(path))).rejects.toThrow("格式")
  })
  it("reports removed files", async () => {
    await expect(readToolImagePreview(part(join(tmpdir(), "missing-read-preview.png")))).rejects.toThrow("不存在")
  })
  it("rejects oversized images before loading their bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "read-preview-")); directories.push(directory)
    const path = join(directory, "huge.png"); await writeFile(path, png)
    await truncate(path, 10 * 1024 * 1024 + 1)
    await expect(readToolImagePreview(part(path))).rejects.toThrow("图片过大")
  })
})
