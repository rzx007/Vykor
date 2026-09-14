import { mkdtemp, mkdir, open, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  clipboard: { writeText: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}))

import {
  createAnimatedGif,
  createAvifDeclaringSize,
  createBmpDeclaringSize,
  createGifDeclaringSize,
  createJpegDeclaringSize,
  createPngDeclaringSize,
  createSolidPng,
  createWebpDeclaringSize,
} from "../image-preview/safe-image-test-bytes"
import { maxImagePreviewBytes, workspaceService } from "./workspace-service"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe("WorkspaceService.listFiles", () => {
  it("returns files beyond the former 5,000-entry boundary", async () => {
    const rootPath = await createTemporaryDirectory()
    await Promise.all(
      Array.from({ length: 5_001 }, (_, index) =>
        writeFile(join(rootPath, `file-${String(index).padStart(4, "0")}.txt`), "")
      )
    )

    const result = await workspaceService.listFiles({ rootPath })

    expect(result.entries).toHaveLength(5_001)
    expect(result.entries.at(-1)?.path).toBe("file-5000.txt")
  }, 90_000)

  it("keeps ignored directories out of the complete listing", async () => {
    const rootPath = await createTemporaryDirectory()
    await mkdir(join(rootPath, "node_modules"))
    await writeFile(join(rootPath, "node_modules", "ignored.js"), "")
    await writeFile(join(rootPath, "visible.ts"), "")

    const result = await workspaceService.listFiles({ rootPath })

    expect(result.entries.map((entry) => entry.path)).toEqual(["visible.ts"])
  })

  it("sorts directories before files and names within each group", async () => {
    const rootPath = await createTemporaryDirectory()
    await mkdir(join(rootPath, "z-directory"))
    await mkdir(join(rootPath, "a-directory"))
    await writeFile(join(rootPath, "z-file.ts"), "")
    await writeFile(join(rootPath, "a-file.ts"), "")

    const result = await workspaceService.listFiles({ rootPath })

    expect(result.entries.map((entry) => entry.path)).toEqual([
      "a-directory/",
      "z-directory/",
      "a-file.ts",
      "z-file.ts",
    ])
  })
})

describe("WorkspaceService.readFile image preview", () => {
  it("returns validated PNG bytes for a file tab preview", async () => {
    const rootPath = await createTemporaryDirectory()
    const bytes = await createSolidPng(1, 1)
    await writeFile(join(rootPath, "image.png"), bytes)

    const result = await workspaceService.readFile({ rootPath, path: "image.png" })

    expect(result).toMatchObject({
      binary: true,
      content: null,
      mediaType: "image/png",
      imagePreviewError: null,
    })
    expect(bytesOf(result.previewBytes)).toEqual([...bytes])
  })

  it("rejects active content disguised as PNG", async () => {
    const rootPath = await createTemporaryDirectory()
    await writeFile(join(rootPath, "active.png"), '<svg onload="alert(1)"></svg>')

    const result = await workspaceService.readFile({ rootPath, path: "active.png" })

    expect(result).toMatchObject({
      binary: true,
      content: null,
      previewBytes: null,
      mediaType: null,
      imagePreviewError: "image_unsupported",
    })
  })

  it("keeps SVG in the text preview flow", async () => {
    const rootPath = await createTemporaryDirectory()
    const content = '<svg viewBox="0 0 1 1"></svg>'
    await writeFile(join(rootPath, "vector.svg"), content)

    const result = await workspaceService.readFile({ rootPath, path: "vector.svg" })

    expect(result).toMatchObject({
      binary: false,
      content,
      previewBytes: null,
      mediaType: null,
      imagePreviewError: null,
    })
  })

  it("does not read image bytes beyond the 50 MB preview limit", async () => {
    const rootPath = await createTemporaryDirectory()
    const path = join(rootPath, "huge.png")
    await createSizedPng(path, maxImagePreviewBytes + 1)

    const result = await workspaceService.readFile({ rootPath, path: "huge.png" })

    expect(result).toMatchObject({
      binary: true,
      content: null,
      previewBytes: null,
      mediaType: "image/png",
      imagePreviewError: "image_too_large",
    })
  })

  it("allows an image exactly at the 50 MB preview limit", async () => {
    const rootPath = await createTemporaryDirectory()
    const path = join(rootPath, "boundary.png")
    await createSizedPng(path, maxImagePreviewBytes)

    const result = await workspaceService.readFile({ rootPath, path: "boundary.png" })

    expect(result.mediaType).toBe("image/png")
    expect(result.imagePreviewError).toBeNull()
    expect(result.previewBytes?.byteLength).toBe(maxImagePreviewBytes)
  }, 30_000)

  it.each([
    ["png", "image.png", () => createPngDeclaringSize(32_768, 32_768)],
    ["jpeg", "image.jpg", () => createJpegDeclaringSize(32_768, 32_768)],
    ["gif", "image.gif", async () => createGifDeclaringSize(32_768, 32_768, 1)],
    ["webp", "image.webp", () => createWebpDeclaringSize(16_383, 16_383)],
    ["bmp", "image.bmp", async () => createBmpDeclaringSize(32_768, 32_768)],
    ["avif", "image.avif", () => createAvifDeclaringSize(32_768, 32_768)],
  ] as const)(
    "rejects a compact %s pixel bomb before returning preview bytes",
    async (_format, name, bytes) => {
      const rootPath = await createTemporaryDirectory()
      const payload = await bytes()
      await writeFile(join(rootPath, name), payload)

      const result = await workspaceService.readFile({ rootPath, path: name })

      expect(payload.byteLength).toBeLessThan(4_096)
      expect(result).toMatchObject({
        binary: true,
        content: null,
        previewBytes: null,
        imagePreviewError: "image_too_large",
      })
    }
  )

  it("rejects an animated GIF that exceeds the frame budget", async () => {
    const rootPath = await createTemporaryDirectory()
    const payload = createAnimatedGif(65)
    await writeFile(join(rootPath, "frames.gif"), payload)

    const result = await workspaceService.readFile({ rootPath, path: "frames.gif" })

    expect(payload.byteLength).toBeLessThan(4_096)
    expect(result).toMatchObject({
      previewBytes: null,
      mediaType: "image/gif",
      imagePreviewError: "image_too_large",
    })
  })

  it("rejects a signature-only PNG that has no readable image layout", async () => {
    const rootPath = await createTemporaryDirectory()
    await writeFile(
      join(rootPath, "header-only.png"),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    )

    const result = await workspaceService.readFile({ rootPath, path: "header-only.png" })

    expect(result).toMatchObject({
      binary: true,
      content: null,
      previewBytes: null,
      mediaType: null,
      imagePreviewError: "image_unsupported",
    })
  })
})

describe("WorkspaceService.readFile extra-root", () => {
  it("reads a personal skill from an extra root", async () => {
    const project = await createTemporaryDirectory()
    const configDir = await createTemporaryDirectory()
    const documentsPath = await createTemporaryDirectory()
    const skillPath = join(configDir, "skills", "show-me", "SKILL.md")
    await mkdir(join(configDir, "skills", "show-me"), { recursive: true })
    await writeFile(skillPath, "# skill\n")
    workspaceService.configureAllowedRoots({ configDir, documentsPath })

    const result = await workspaceService.readFile({
      rootPath: project,
      path: skillPath,
    })

    expect(result).toMatchObject({
      scope: "extra-root",
      relativePath: "skills/show-me/SKILL.md",
      rootLabel: "个人配置",
      content: "# skill\n",
      previewBytes: null,
      mediaType: null,
      imagePreviewError: null,
    })
  })

  it("returns safe image bytes from an extra root", async () => {
    const project = await createTemporaryDirectory()
    const configDir = await createTemporaryDirectory()
    const documentsPath = await createTemporaryDirectory()
    const imagePath = join(configDir, "skills", "show-me", "preview.png")
    await mkdir(join(configDir, "skills", "show-me"), { recursive: true })
    const bytes = await createSolidPng(1, 1)
    await writeFile(imagePath, bytes)
    workspaceService.configureAllowedRoots({ configDir, documentsPath })

    const result = await workspaceService.readFile({
      rootPath: project,
      path: imagePath,
    })

    expect(result).toMatchObject({
      scope: "extra-root",
      relativePath: "skills/show-me/preview.png",
      mediaType: "image/png",
      imagePreviewError: null,
    })
    expect(bytesOf(result.previewBytes)).toEqual([...bytes])
  })

  it("does not follow a symlink that escapes the allowed root", async () => {
    const project = await createTemporaryDirectory()
    const configDir = await createTemporaryDirectory()
    const documentsPath = await createTemporaryDirectory()
    const outside = await createTemporaryDirectory()
    const target = join(outside, "secret.txt")
    await writeFile(target, "secret")
    const link = join(configDir, "skills", "leak.md")
    await mkdir(join(configDir, "skills"), { recursive: true })
    try {
      await symlink(target, link)
    } catch {
      return
    }
    workspaceService.configureAllowedRoots({ configDir, documentsPath })

    await expect(workspaceService.readFile({ rootPath: project, path: link })).rejects.toThrow(
      "文件必须位于当前项目目录内。"
    )
  })

  it("does not read credentials.json from the config directory", async () => {
    const project = await createTemporaryDirectory()
    const configDir = await createTemporaryDirectory()
    await writeFile(join(configDir, "credentials.json"), '{"token":"x"}')
    workspaceService.configureAllowedRoots({
      configDir,
      documentsPath: await createTemporaryDirectory(),
    })

    await expect(
      workspaceService.readFile({
        rootPath: project,
        path: join(configDir, "credentials.json"),
      })
    ).rejects.toThrow()
  })
})

async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "openharness-workspace-"))
  temporaryDirectories.push(path)
  return path
}

function bytesOf(buffer: ArrayBuffer | null): number[] | null {
  return buffer ? [...new Uint8Array(buffer)] : null
}

async function createSizedPng(path: string, size: number): Promise<void> {
  const handle = await open(path, "w")
  try {
    const bytes = await createSolidPng(1, 1)
    await handle.write(bytes, 0, bytes.byteLength, 0)
    await handle.truncate(size)
  } finally {
    await handle.close()
  }
}
