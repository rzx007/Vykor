import {
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({ clipboard: {}, shell: {} }))
vi.mock("../session/session-service", () => ({ desktopSessionService: {} }))
import { workspaceService } from "./workspace-service"

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "vykor-save-"))
  directories.push(path)
  return path
}

describe("workspace source editing", () => {
  it("leaves the original file intact if a save fails after a partial write", async () => {
    const rootPath = await directory()
    const path = join(rootPath, "a.ts")
    await writeFile(path, "original text")
    const handle = await open(path, "r+")
    const prototype = Object.getPrototypeOf(handle) as FileHandle
    const write = prototype.write as (
      this: FileHandle,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number
    ) => Promise<{ bytesWritten: number; buffer: Uint8Array }>
    await handle.close()
    vi.spyOn(prototype, "write")
      .mockImplementationOnce(async function (
        this: FileHandle,
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number
      ) {
        return write.call(this, buffer, offset, Math.min(3, length), position)
      } as FileHandle["write"])
      .mockRejectedValueOnce(new Error("ENOSPC: no space left"))
    await expect(
      workspaceService.writeFile({
        rootPath,
        path: "a.ts",
        originalContent: "original text",
        content: "replacement text",
      })
    ).rejects.toThrow("ENOSPC")
    expect(await readFile(path, "utf8")).toBe("original text")
    expect(await readdir(rootPath)).toEqual(["a.ts"])
  })
  it("preserves an external update made while the replacement is being prepared", async () => {
    const rootPath = await directory()
    const path = join(rootPath, "a.ts")
    await writeFile(path, "original text")
    const handle = await open(path, "r+")
    const prototype = Object.getPrototypeOf(handle) as FileHandle
    const write = prototype.write as (
      this: FileHandle,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number
    ) => Promise<{ bytesWritten: number; buffer: Uint8Array }>
    await handle.close()
    vi.spyOn(prototype, "write").mockImplementationOnce(async function (
      this: FileHandle,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number
    ) {
      const result = await write.call(this, buffer, offset, length, position)
      await writeFile(path, "external update")
      return result
    } as FileHandle["write"])
    await expect(
      workspaceService.writeFile({
        rootPath,
        path: "a.ts",
        originalContent: "original text",
        content: "replacement text",
      })
    ).rejects.toThrow("已被其他程序修改")
    expect(await readFile(path, "utf8")).toBe("external update")
    expect(await readdir(rootPath)).toEqual(["a.ts"])
  })
  it("saves UTF-8 text and returns the refreshed preview, preserving BOM and CRLF", async () => {
    const rootPath = await directory()
    await writeFile(join(rootPath, "a.ts"), "\uFEFFconst 名称 = 1\r\n")
    const result = await workspaceService.writeFile({
      rootPath,
      path: "a.ts",
      originalContent: "const 名称 = 1\r\n",
      content: "const 名称 = 2\r\n",
    })
    expect(result.content).toBe("const 名称 = 2\r\n")
    expect(await readFile(join(rootPath, "a.ts"), "utf8")).toBe("\uFEFFconst 名称 = 2\r\n")
  })
  it("refuses to overwrite a file changed outside the editor", async () => {
    const rootPath = await directory()
    await writeFile(join(rootPath, "a.ts"), "external change")
    await expect(
      workspaceService.writeFile({
        rootPath,
        path: "a.ts",
        originalContent: "old",
        content: "draft",
      })
    ).rejects.toThrow("已被其他程序修改")
    expect(await readFile(join(rootPath, "a.ts"), "utf8")).toBe("external change")
  })
  it("supports empty files and rejects binary or invalid UTF-8 without changing bytes", async () => {
    const rootPath = await directory()
    await writeFile(join(rootPath, "empty.ts"), "")
    await workspaceService.writeFile({
      rootPath,
      path: "empty.ts",
      originalContent: "",
      content: "new",
    })
    expect(await readFile(join(rootPath, "empty.ts"), "utf8")).toBe("new")
    for (const bytes of [Buffer.from([0, 1]), Buffer.from([0xff, 0xfe])]) {
      await writeFile(join(rootPath, "bad.txt"), bytes)
      await expect(
        workspaceService.writeFile({
          rootPath,
          path: "bad.txt",
          originalContent: "",
          content: "draft",
        })
      ).rejects.toThrow()
      expect(await readFile(join(rootPath, "bad.txt"))).toEqual(bytes)
    }
  })
  it("rejects traversal, external links, and oversized output", async () => {
    const rootPath = await directory()
    const outside = await directory()
    await writeFile(join(outside, "a.ts"), "secret")
    await symlink(outside, join(rootPath, "linked"), "junction")
    for (const path of [join(outside, "a.ts"), "linked/a.ts", "../a.ts"]) {
      await expect(
        workspaceService.writeFile({ rootPath, path, originalContent: "secret", content: "draft" })
      ).rejects.toThrow()
    }
    await writeFile(join(rootPath, "a.ts"), "old")
    await expect(
      workspaceService.writeFile({
        rootPath,
        path: "a.ts",
        originalContent: "old",
        content: "x".repeat(1_250_001),
      })
    ).rejects.toThrow("过大")
    expect(await readFile(join(rootPath, "a.ts"), "utf8")).toBe("old")
    expect(await readFile(join(outside, "a.ts"), "utf8")).toBe("secret")
  })
})
