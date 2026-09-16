import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AttachmentAssetRecord, UploadAttachmentInput } from "@openharness/client"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import { createSolidPng } from "../image-preview/safe-image-test-bytes"

import type { DesktopAttachmentUploadEvent } from "../../../shared/attachment-types"
import {
  createAttachmentService,
  type AttachmentFileSystem,
  type DesktopAttachmentService,
} from "./attachment-service"

const temporaryDirectories: string[] = []
let pngFixture: Uint8Array<ArrayBuffer>

beforeAll(async () => {
  const bytes = await createSolidPng(1, 1)
  pngFixture = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  pngFixture.set(bytes)
})

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe("DesktopAttachmentService source tokens", () => {
  it("keeps source tokens private to their owner and expires them on owner disposal", async () => {
    const filePath = await temporaryFile("private.txt", "secret")
    const service = createService()
    const [candidate] = await service.stagePaths(11, [filePath])

    await expect(
      service.startUpload(12, {
        draftId: candidate!.draftId,
        sourceToken: candidate!.sourceToken,
      })
    ).rejects.toMatchObject({ code: "attachment_source_forbidden" })

    await service.disposeOwner(11)
    await expect(
      service.startUpload(11, {
        draftId: candidate!.draftId,
        sourceToken: candidate!.sourceToken,
      })
    ).rejects.toMatchObject({ code: "attachment_source_expired" })
  })

  it("rejects directories and consumes a token only once", async () => {
    const root = await temporaryDirectory()
    const filePath = join(root, "once.txt")
    await writeFile(filePath, "one upload")
    const uploads: UploadAttachmentInput[] = []
    const service = createService({
      uploadAttachment: async (input) => {
        uploads.push(input)
        return readyAsset("asset-once", input.displayName, 10)
      },
    })

    await expect(service.stagePaths(1, [root])).rejects.toMatchObject({
      code: "attachment_source_not_file",
    })
    const [candidate] = await service.stagePaths(1, [filePath])
    await service.startUpload(1, {
      draftId: candidate!.draftId,
      sourceToken: candidate!.sourceToken,
    })
    await expect(
      service.startUpload(1, {
        draftId: candidate!.draftId,
        sourceToken: candidate!.sourceToken,
      })
    ).rejects.toMatchObject({ code: "attachment_source_expired" })
    await service.whenIdle()

    expect(uploads).toHaveLength(1)
  })

  it("rejects symbolic links, unreadable files, and naturally expired tokens", async () => {
    const symlinkService = createService({
      fileSystem: { lstat: async () => ({ isSymbolicLink: () => true }) },
    })
    await expect(symlinkService.stagePaths(1, ["symbolic-link"])).rejects.toMatchObject({
      code: "attachment_source_symlink",
    })
    const unreadableService = createService({
      fileSystem: {
        lstat: async () => ({ isSymbolicLink: () => false }),
        realpath: async () => "unreadable",
        stat: async () => ({ isFile: () => true, size: 1 }),
        assertReadable: async () => {
          throw new Error("denied")
        },
      },
    })
    await expect(unreadableService.stagePaths(1, ["unreadable"])).rejects.toMatchObject({
      code: "attachment_source_unreadable",
    })

    let now = 10_000
    const service = createService({ now: () => now })
    const filePath = await temporaryFile("expires.txt", "soon")
    const [candidate] = await service.stagePaths(1, [filePath])
    now = 100_001
    await expect(
      service.startUpload(1, {
        draftId: candidate!.draftId,
        sourceToken: candidate!.sourceToken,
      })
    ).rejects.toMatchObject({ code: "attachment_source_expired" })
  })
})

describe("DesktopAttachmentService asset actions", () => {
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

  it("reads the daemon copy after the original source file has been deleted", async () => {
    const sourcePath = await temporaryFile("durable.png", pngBytes())
    let storedBytes = new Uint8Array(new ArrayBuffer(0))
    let storedAsset = readyAsset("asset-durable", "durable.png", 0, "image/png")
    const service = createService({
      uploadAttachment: async (input) => {
        storedBytes = await consumeBytes(input.body)
        storedAsset = readyAsset(
          "asset-durable",
          input.displayName,
          storedBytes.byteLength,
          "image/png"
        )
        return storedAsset
      },
      getAttachment: async () => storedAsset,
      downloadAttachment: async () => new Response(toArrayBuffer(storedBytes)),
    })
    const [candidate] = await service.stagePaths(17, [sourcePath])
    await service.startUpload(17, {
      draftId: candidate!.draftId,
      sourceToken: candidate!.sourceToken,
    })
    await service.whenIdle()
    await rm(sourcePath, { force: true })

    await expect(service.readPreview("asset-durable")).resolves.toEqual({
      bytes: toArrayBuffer(pngBytes()),
      mediaType: "image/png",
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

  it("treats attachment_in_use as an idempotent unreferenced cleanup result", async () => {
    const service = createService({
      deleteAttachment: async () => {
        throw { body: { error: { code: "attachment_in_use" } } }
      },
    })

    await expect(service.deleteUnreferenced("asset-used")).resolves.toEqual({
      deleted: false,
      inUse: true,
    })
  })
})

describe("DesktopAttachmentService uploads", () => {
  it("retries a failed source with a new task id without exposing its path again", async () => {
    let attempt = 0
    const events: DesktopAttachmentUploadEvent[] = []
    const service = createService({
      emit: (_ownerId, event) => events.push(event),
      uploadAttachment: async (input) => {
        attempt += 1
        if (attempt === 1) throw new Error("offline")
        return readyAsset("asset-retried", input.displayName, await consume(input.body))
      },
    })
    const [candidate] = await service.stagePaths(13, [await temporaryFile("retry.txt", "retry")])
    await service.startUpload(13, {
      draftId: candidate!.draftId,
      sourceToken: candidate!.sourceToken,
      taskId: "task-first",
    })
    await service.whenIdle()

    await service.retryUpload(13, {
      draftId: candidate!.draftId,
      taskId: "task-second",
    })
    await service.whenIdle()

    expect(events).toContainEqual(expect.objectContaining({ type: "failed", taskId: "task-first" }))
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "success",
        taskId: "task-second",
        assetId: "asset-retried",
      })
    )
  })

  it("uploads a pathless clipboard image and enforces the same byte limit", async () => {
    const uploads: UploadAttachmentInput[] = []
    const service = createService({
      uploadAttachment: async (input) => {
        uploads.push(input)
        return readyAsset(
          "asset-clipboard",
          input.displayName,
          await consume(input.body),
          "image/png"
        )
      },
    })

    const { taskId } = await service.uploadMemory(3, {
      draftId: "draft-clipboard",
      displayName: "clipboard.png",
      mediaType: "image/png",
      bytes: Uint8Array.of(1, 2, 3),
    })
    await service.whenIdle()

    expect(taskId).toEqual(expect.any(String))
    expect(uploads).toHaveLength(1)
    await expect(
      service.uploadMemory(3, {
        draftId: "draft-large",
        displayName: "large.png",
        mediaType: "image/png",
        bytes: new Uint8Array(2_000_001),
      })
    ).rejects.toMatchObject({ code: "attachment_file_too_large" })
  })

  it("streams bytes, reports monotonic progress, and emits a ready asset", async () => {
    const filePath = await temporaryFile(
      "stream.bin",
      Uint8Array.from({ length: 192_000 }, (_, i) => i)
    )
    const events: DesktopAttachmentUploadEvent[] = []
    const service = createService({
      emit: (_ownerId, event) => events.push(event),
      uploadAttachment: async (input) => {
        const sizeBytes = await consume(input.body)
        return readyAsset("asset-stream", input.displayName, sizeBytes, "application/octet-stream")
      },
    })
    const [candidate] = await service.stagePaths(7, [filePath])
    const { taskId } = await service.startUpload(7, {
      draftId: candidate!.draftId,
      sourceToken: candidate!.sourceToken,
    })
    await service.whenIdle()

    const progress = events.filter((event) => event.type === "progress")
    expect(progress.map((event) => event.bytesRead)).toEqual(
      [...progress.map((event) => event.bytesRead as number)].sort((a, b) => a - b)
    )
    expect(events.at(-1)).toMatchObject({
      type: "success",
      taskId,
      draftId: candidate!.draftId,
      assetId: "asset-stream",
      sizeBytes: 192_000,
    })
  })

  it("aborts a running task and ignores a client completion that arrives late", async () => {
    let resolveUpload!: (asset: AttachmentAssetRecord) => void
    let uploadSignal: AbortSignal | undefined
    const events: DesktopAttachmentUploadEvent[] = []
    const service = createService({
      emit: (_ownerId, event) => events.push(event),
      uploadAttachment: (input) => {
        uploadSignal = input.signal
        return new Promise((resolve) => {
          resolveUpload = resolve
        })
      },
    })
    const [candidate] = await service.stagePaths(9, [await temporaryFile("late.txt", "late")])
    const { taskId } = await service.startUpload(9, {
      draftId: candidate!.draftId,
      sourceToken: candidate!.sourceToken,
    })
    await waitUntil(() => uploadSignal !== undefined)

    await service.cancelUpload(9, taskId)
    expect(uploadSignal!.aborted).toBe(true)
    resolveUpload(readyAsset("asset-too-late", "late.txt", 4))
    await service.whenIdle()

    expect(events).toContainEqual(expect.objectContaining({ type: "cancelled", taskId }))
    expect(events).not.toContainEqual(expect.objectContaining({ type: "success", taskId }))
  })

  it("aborts every running upload when its window owner is destroyed", async () => {
    let resolveUpload!: (asset: AttachmentAssetRecord) => void
    let uploadSignal: AbortSignal | undefined
    const events: DesktopAttachmentUploadEvent[] = []
    const service = createService({
      emit: (_ownerId, event) => events.push(event),
      uploadAttachment: (input) => {
        uploadSignal = input.signal
        return new Promise((resolve) => {
          resolveUpload = resolve
        })
      },
    })
    const [candidate] = await service.stagePaths(18, [await temporaryFile("window.txt", "bye")])
    const { taskId } = await service.startUpload(18, {
      draftId: candidate!.draftId,
      sourceToken: candidate!.sourceToken,
    })
    await waitUntil(() => uploadSignal !== undefined)

    await service.disposeOwner(18)
    expect(uploadSignal!.aborted).toBe(true)
    resolveUpload(readyAsset("asset-too-late", "window.txt", 3))
    await service.whenIdle()

    expect(events).toContainEqual(expect.objectContaining({ type: "cancelled", taskId }))
    expect(events).not.toContainEqual(expect.objectContaining({ type: "success", taskId }))
  })

  it("never exposes upload paths, tokens, authorization values, or stacks in public errors", async () => {
    const events: DesktopAttachmentUploadEvent[] = []
    const service = createService({
      emit: (_ownerId, event) => events.push(event),
      uploadAttachment: async () => {
        throw new Error(
          "Authorization: Bearer secret-token C:\\private\\report.pdf\nstack: internal-location"
        )
      },
    })
    const [candidate] = await service.stagePaths(19, [await temporaryFile("safe.txt", "safe")])
    await service.startUpload(19, {
      draftId: candidate!.draftId,
      sourceToken: candidate!.sourceToken,
      taskId: "task-redacted",
    })
    await service.whenIdle()

    const serialized = JSON.stringify(events)
    expect(serialized).toContain("attachment_upload_failed")
    expect(serialized).not.toMatch(/Authorization|secret-token|private|stack/i)
  })

  it("runs at most three uploads and never opens a queued task cancelled by its owner", async () => {
    const files = await Promise.all(
      Array.from({ length: 5 }, (_, index) => temporaryFile(`queue-${index}.txt`, `${index}`))
    )
    let active = 0
    let maximumActive = 0
    const releases: Array<() => void> = []
    const opened: string[] = []
    const service = createService({
      onOpenSource: (path) => opened.push(path),
      uploadAttachment: async (input) => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await new Promise<void>((resolve) => releases.push(resolve))
        active -= 1
        return readyAsset(`asset-${input.displayName}`, input.displayName, 1)
      },
    })
    const candidates = await service.stagePaths(5, files)
    const tasks = await Promise.all(
      candidates.map((candidate) =>
        service.startUpload(5, {
          draftId: candidate.draftId,
          sourceToken: candidate.sourceToken,
        })
      )
    )
    await waitUntil(() => releases.length === 3)

    await service.cancelUpload(5, tasks[4]!.taskId)
    while (releases.length > 0) releases.shift()!()
    await waitUntil(() => releases.length === 1)
    while (releases.length > 0) releases.shift()!()
    await service.whenIdle()

    expect(maximumActive).toBe(3)
    expect(opened).not.toContain(files[4])
  })
})

function createService(
  overrides: {
    emit?: (ownerId: number, event: DesktopAttachmentUploadEvent) => void
    uploadAttachment?: (input: UploadAttachmentInput) => Promise<AttachmentAssetRecord>
    onOpenSource?: (path: string) => void
    now?: () => number
    getAttachment?: (id: string) => Promise<AttachmentAssetRecord>
    downloadAttachment?: (id: string) => Promise<Response>
    deleteAttachment?: (id: string) => Promise<AttachmentAssetRecord>
    temporaryRoot?: string
    openPath?: (path: string) => Promise<string>
    chooseSavePath?: (displayName: string) => Promise<string | null>
    fileSystem?: Partial<AttachmentFileSystem>
  } = {}
): DesktopAttachmentService {
  return createAttachmentService({
    sourceTokenTtlMs: 60_000,
    maxBytesPerFile: 2_000_000,
    emit: overrides.emit ?? (() => undefined),
    getClient: async () => ({
      attachments: {
        upload:
          overrides.uploadAttachment ??
          (async (input) => readyAsset("asset-default", input.displayName, 0)),
        get: overrides.getAttachment ?? vi.fn(),
        download: overrides.downloadAttachment ?? vi.fn(),
        delete: overrides.deleteAttachment ?? vi.fn(),
        scanStorage: vi.fn(),
        repairStorage: vi.fn(),
        gcStorage: vi.fn(),
      },
    }),
    onOpenSource: overrides.onOpenSource,
    now: overrides.now,
    temporaryRoot: overrides.temporaryRoot,
    openPath: overrides.openPath,
    chooseSavePath: overrides.chooseSavePath,
    fileSystem: overrides.fileSystem,
  })
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "openharness-attachment-"))
  temporaryDirectories.push(path)
  return path
}

async function temporaryFile(name: string, contents: string | Uint8Array): Promise<string> {
  const root = await temporaryDirectory()
  const path = join(root, name)
  await writeFile(path, contents)
  return path
}

function readyAsset(
  id: string,
  displayName: string,
  sizeBytes: number,
  mediaType = "text/plain"
): AttachmentAssetRecord {
  return {
    id,
    displayName,
    declaredMediaType: mediaType,
    mediaType,
    sizeBytes,
    status: "ready",
    createdAt: 1,
    updatedAt: 1,
  }
}

async function consume(body: UploadAttachmentInput["body"]): Promise<number> {
  return (await consumeBytes(body)).byteLength
}

async function consumeBytes(body: UploadAttachmentInput["body"]): Promise<Uint8Array<ArrayBuffer>> {
  if (!(body instanceof ReadableStream)) throw new Error("expected a ReadableStream")
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const result = await reader.read()
    if (result.done) {
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return bytes
    }
    chunks.push(result.value)
    size += result.value.byteLength
  }
}

function pngBytes(): Uint8Array<ArrayBuffer> {
  return pngFixture
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  copy.set(bytes)
  return copy.buffer
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("condition was not met")
}
