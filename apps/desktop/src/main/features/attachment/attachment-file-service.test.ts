import { access, readFile } from "node:fs/promises"
import { join } from "node:path"

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import {
  cleanupTemporaryDirectories,
  createService,
  loadPngFixture,
  pngBytes,
  readyAsset,
  temporaryDirectory,
  toArrayBuffer,
} from "./__test__/attachment-test-fixtures"

beforeAll(async () => {
  await loadPngFixture()
})

afterEach(async () => {
  await cleanupTemporaryDirectories()
})

describe("AttachmentFileService", () => {
  it("only previews safe bitmap media and enforces the preview byte limit", async () => {
    const downloadAttachment = vi.fn(async () => new Response(toArrayBuffer(pngBytes())))
    const getAttachment = vi.fn(async (id: string) => {
      if (id === "unsafe") return readyAsset(id, "page.html", 3, "text/html")
      if (id === "too-large") return readyAsset(id, "huge.png", 2_000_001, "image/png")
      return readyAsset(id, "image.png", pngBytes().byteLength, "image/png")
    })
    const service = createService({ getAttachment, downloadAttachment })

    await expect(service.readPreview("safe")).resolves.toEqual({
      bytes: toArrayBuffer(pngBytes()),
      mediaType: "image/png",
    })
    await expect(service.readPreview("unsafe")).rejects.toMatchObject({
      code: "attachment_preview_unsupported",
    })
    await expect(service.readPreview("too-large")).rejects.toMatchObject({
      code: "attachment_preview_too_large",
    })
    expect(downloadAttachment).toHaveBeenCalledTimes(1)
  })

  it("rejects SVG or HTML bytes disguised with a safe bitmap media type", async () => {
    const activeContent = new TextEncoder().encode('<svg onload="alert(1)"></svg>')
    const service = createService({
      getAttachment: async (id) =>
        readyAsset(id, "disguised.png", activeContent.byteLength, "image/png"),
      downloadAttachment: async () => new Response(toArrayBuffer(activeContent)),
    })

    await expect(service.readPreview("disguised")).rejects.toMatchObject({
      code: "attachment_preview_unsupported",
    })
  })

  it("opens from its managed temporary directory, cleans it, and saves through a chosen path", async () => {
    const temporaryRoot = await temporaryDirectory()
    const savePath = join(temporaryRoot, "saved.txt")
    const openedPaths: string[] = []
    const service = createService({
      temporaryRoot,
      getAttachment: async (id) => readyAsset(id, "report.txt", 4),
      downloadAttachment: async () => new Response("data"),
      openPath: async (path) => {
        openedPaths.push(path)
        return ""
      },
      chooseSavePath: async () => savePath,
    })

    await service.openAttachment("asset-open")
    expect(openedPaths).toHaveLength(1)
    expect(openedPaths[0]!.startsWith(temporaryRoot)).toBe(true)
    await expect(access(openedPaths[0]!)).resolves.toBeUndefined()

    await expect(service.saveAs("asset-save")).resolves.toEqual({ saved: true })
    await expect(readFile(savePath, "utf8")).resolves.toBe("data")

    await service.cleanupTemporaryFiles()
    await expect(access(openedPaths[0]!)).rejects.toBeDefined()
  })
})
