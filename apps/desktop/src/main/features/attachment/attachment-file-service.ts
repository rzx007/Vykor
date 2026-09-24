import { join } from "node:path"

import type { SafeImageMediaType } from "@shared/safe-image-preview"
import { evaluateInspectedImagePreview } from "../image-preview/inspect-safe-image-layout"

import {
  DesktopAttachmentServiceError,
  SAFE_PREVIEW_MEDIA_TYPES,
  type AttachmentClient,
  type AttachmentFileSystem,
  safeDisplayName,
  serviceError,
} from "./attachment-support"

export interface AttachmentFileServiceDependencies {
  maxBytesPerFile: number
  getClient(): Promise<AttachmentClient>
  fileSystem: AttachmentFileSystem
  temporaryRoot?: string
  openPath?: (path: string) => Promise<string>
  chooseSavePath?: (displayName: string) => Promise<string | null>
  temporaryFileTtlMs?: number
}

export class AttachmentFileService {
  private readonly managedTemporaryDirectories = new Set<string>()

  constructor(private readonly dependencies: AttachmentFileServiceDependencies) {}

  async readPreview(assetId: string): Promise<{ bytes: ArrayBuffer; mediaType: string }> {
    const client = await this.dependencies.getClient()
    const asset = await client.attachments.get(assetId)
    const mediaType = asset.mediaType ?? asset.declaredMediaType ?? "application/octet-stream"
    if (!SAFE_PREVIEW_MEDIA_TYPES.has(mediaType)) {
      throw serviceError("attachment_preview_unsupported")
    }
    const previewLimit = Math.min(this.dependencies.maxBytesPerFile, 10 * 1024 * 1024)
    if ((asset.sizeBytes ?? 0) > previewLimit) throw serviceError("attachment_preview_too_large")
    const response = await client.attachments.download(assetId)
    const bytes = await readResponseBytes(response, previewLimit)
    const decision = await evaluateInspectedImagePreview(bytes, mediaType as SafeImageMediaType)
    if (!decision.ok) {
      throw serviceError(
        decision.error === "image_too_large"
          ? "attachment_preview_too_large"
          : "attachment_preview_unsupported"
      )
    }
    return { bytes: exactArrayBuffer(bytes), mediaType }
  }

  async openAttachment(assetId: string): Promise<void> {
    if (!this.dependencies.temporaryRoot || !this.dependencies.openPath) {
      throw serviceError("attachment_open_unavailable")
    }
    const client = await this.dependencies.getClient()
    const asset = await client.attachments.get(assetId)
    const directory = await this.dependencies.fileSystem.mkdtemp(
      join(this.dependencies.temporaryRoot, "vykor-attachment-")
    )
    this.managedTemporaryDirectories.add(directory)
    const targetPath = join(directory, safeDisplayName(asset.displayName))
    try {
      const response = await client.attachments.download(assetId)
      const bytes = await readResponseBytes(response, this.dependencies.maxBytesPerFile)
      await this.dependencies.fileSystem.writeFile(targetPath, bytes)
      const error = await this.dependencies.openPath(targetPath)
      if (error) throw serviceError("attachment_open_failed")
      this.scheduleTemporaryCleanup(directory)
    } catch (error) {
      await this.cleanupTemporaryDirectory(directory)
      throw error instanceof DesktopAttachmentServiceError
        ? error
        : serviceError("attachment_open_failed")
    }
  }

  async saveAs(assetId: string): Promise<{ saved: boolean }> {
    if (!this.dependencies.chooseSavePath) throw serviceError("attachment_save_unavailable")
    const client = await this.dependencies.getClient()
    const asset = await client.attachments.get(assetId)
    const targetPath = await this.dependencies.chooseSavePath(safeDisplayName(asset.displayName))
    if (!targetPath) return { saved: false }
    try {
      const response = await client.attachments.download(assetId)
      const bytes = await readResponseBytes(response, this.dependencies.maxBytesPerFile)
      await this.dependencies.fileSystem.writeFile(targetPath, bytes)
      return { saved: true }
    } catch {
      throw new DesktopAttachmentServiceError(
        "attachment_save_failed",
        "附件保存失败，请重试。",
        true
      )
    }
  }

  async cleanupTemporaryFiles(): Promise<void> {
    await Promise.all(
      [...this.managedTemporaryDirectories].map((path) => this.cleanupTemporaryDirectory(path))
    )
  }

  private scheduleTemporaryCleanup(directory: string): void {
    const timeout = setTimeout(
      () => void this.cleanupTemporaryDirectory(directory).catch(() => undefined),
      this.dependencies.temporaryFileTtlMs ?? 60 * 60 * 1_000
    )
    timeout.unref()
  }

  private async cleanupTemporaryDirectory(directory: string): Promise<void> {
    if (!this.managedTemporaryDirectories.delete(directory)) return
    await this.dependencies.fileSystem.rm(directory, { recursive: true, force: true })
  }
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array()
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw serviceError("attachment_preview_too_large")
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  for (; ;) {
    const result = await reader.read()
    if (result.done) break
    totalBytes += result.value.byteLength
    if (totalBytes > maxBytes) {
      await reader.cancel()
      throw serviceError("attachment_preview_too_large")
    }
    chunks.push(result.value)
  }
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}
