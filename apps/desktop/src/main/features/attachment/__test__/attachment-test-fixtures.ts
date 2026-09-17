import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type {
  AttachmentAssetRecord,
  AttachmentStorageGcResult,
  AttachmentStorageRepairResult,
  AttachmentStorageReport,
  UploadAttachmentInput,
} from "@openharness/client"
import { vi } from "vitest"

import { createSolidPng } from "../../image-preview/safe-image-test-bytes"
import type { DesktopAttachmentUploadEvent } from "../../../../shared/attachment-types"
import {
  createAttachmentService,
  type AttachmentFileSystem,
  type DesktopAttachmentService,
} from "../attachment-service"

export const temporaryDirectories: string[] = []
let pngFixture: Uint8Array<ArrayBuffer>

export async function loadPngFixture(): Promise<void> {
  const bytes = await createSolidPng(1, 1)
  pngFixture = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  pngFixture.set(bytes)
}

export async function cleanupTemporaryDirectories(): Promise<void> {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
}

export function createService(
  overrides: {
    emit?: (ownerId: number, event: DesktopAttachmentUploadEvent) => void
    uploadAttachment?: (input: UploadAttachmentInput) => Promise<AttachmentAssetRecord>
    onOpenSource?: (path: string) => void
    now?: () => number
    getAttachment?: (id: string) => Promise<AttachmentAssetRecord>
    downloadAttachment?: (id: string) => Promise<Response>
    deleteAttachment?: (id: string) => Promise<AttachmentAssetRecord>
    scanStorage?: () => Promise<AttachmentStorageReport>
    repairStorage?: () => Promise<AttachmentStorageRepairResult>
    gcStorage?: () => Promise<AttachmentStorageGcResult>
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
        scanStorage: overrides.scanStorage ?? vi.fn(),
        repairStorage: overrides.repairStorage ?? vi.fn(),
        gcStorage: overrides.gcStorage ?? vi.fn(),
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

export async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "openharness-attachment-"))
  temporaryDirectories.push(path)
  return path
}

export async function temporaryFile(name: string, contents: string | Uint8Array): Promise<string> {
  const root = await temporaryDirectory()
  const path = join(root, name)
  await writeFile(path, contents)
  return path
}

export function readyAsset(
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

export async function consume(body: UploadAttachmentInput["body"]): Promise<number> {
  return (await consumeBytes(body)).byteLength
}

export async function consumeBytes(body: UploadAttachmentInput["body"]): Promise<Uint8Array<ArrayBuffer>> {
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

export function pngBytes(): Uint8Array<ArrayBuffer> {
  return pngFixture
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  copy.set(bytes)
  return copy.buffer
}

export async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("condition was not met")
}
