import { createReadStream } from "node:fs"
import { lstat, mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises"

import type {
  AttachmentStorageGcResult,
  AttachmentStorageRepairResult,
  AttachmentStorageReport,
} from "@openharness/client"

import type { DesktopAttachmentCandidate, DesktopAttachmentUploadEvent } from "@shared/attachment-types"

import { AttachmentFileService } from "./attachment-file-service"
import {
  DesktopAttachmentServiceError,
  type AttachmentClient,
  type AttachmentFileSystem,
} from "./attachment-support"
import {
  AttachmentUploadService,
  type StartAttachmentUploadInput,
  type UploadMemoryAttachmentInput,
} from "./attachment-upload-service"

export type { AttachmentFileSystem }
export { DesktopAttachmentServiceError }
export type { StartAttachmentUploadInput, UploadMemoryAttachmentInput }

export interface AttachmentServiceDependencies {
  sourceTokenTtlMs: number
  maxBytesPerFile: number
  emit(ownerId: number, event: DesktopAttachmentUploadEvent): void
  getClient(): Promise<AttachmentClient>
  now?: () => number
  fileSystem?: Partial<AttachmentFileSystem>
  onOpenSource?: (path: string) => void
  temporaryRoot?: string
  openPath?: (path: string) => Promise<string>
  chooseSavePath?: (displayName: string) => Promise<string | null>
  temporaryFileTtlMs?: number
}

export class DesktopAttachmentService {
  private readonly uploads: AttachmentUploadService
  private readonly files: AttachmentFileService

  constructor(private readonly dependencies: AttachmentServiceDependencies) {
    const fileSystem: AttachmentFileSystem = {
      lstat,
      realpath,
      stat,
      assertReadable: async (path) => {
        const handle = await open(path, "r")
        await handle.close()
      },
      createReadStream,
      mkdtemp,
      writeFile,
      rm,
      ...dependencies.fileSystem,
    }
    this.uploads = new AttachmentUploadService({
      sourceTokenTtlMs: dependencies.sourceTokenTtlMs,
      maxBytesPerFile: dependencies.maxBytesPerFile,
      emit: dependencies.emit,
      getClient: dependencies.getClient,
      fileSystem,
      now: dependencies.now,
      onOpenSource: dependencies.onOpenSource,
    })
    this.files = new AttachmentFileService({
      maxBytesPerFile: dependencies.maxBytesPerFile,
      getClient: dependencies.getClient,
      fileSystem,
      temporaryRoot: dependencies.temporaryRoot,
      openPath: dependencies.openPath,
      chooseSavePath: dependencies.chooseSavePath,
      temporaryFileTtlMs: dependencies.temporaryFileTtlMs,
    })
  }

  stagePaths(
    ownerId: number,
    paths: readonly string[]
  ): Promise<DesktopAttachmentCandidate[]> {
    return this.uploads.stagePaths(ownerId, paths)
  }

  startUpload(
    ownerId: number,
    input: StartAttachmentUploadInput
  ): Promise<{ taskId: string }> {
    return this.uploads.startUpload(ownerId, input)
  }

  cancelUpload(ownerId: number, taskId: string): Promise<void> {
    return this.uploads.cancelUpload(ownerId, taskId)
  }

  uploadMemory(
    ownerId: number,
    input: UploadMemoryAttachmentInput
  ): Promise<{ taskId: string }> {
    return this.uploads.uploadMemory(ownerId, input)
  }

  retryUpload(
    ownerId: number,
    input: { draftId: string; taskId: string }
  ): Promise<{ taskId: string }> {
    return this.uploads.retryUpload(ownerId, input)
  }

  discardDraft(ownerId: number, draftId: string): Promise<void> {
    return this.uploads.discardDraft(ownerId, draftId)
  }

  disposeOwner(ownerId: number): Promise<void> {
    return this.uploads.disposeOwner(ownerId)
  }

  whenIdle(): Promise<void> {
    return this.uploads.whenIdle()
  }

  readPreview(assetId: string): Promise<{ bytes: ArrayBuffer; mediaType: string }> {
    return this.files.readPreview(assetId)
  }

  openAttachment(assetId: string): Promise<void> {
    return this.files.openAttachment(assetId)
  }

  saveAs(assetId: string): Promise<{ saved: boolean }> {
    return this.files.saveAs(assetId)
  }

  cleanupTemporaryFiles(): Promise<void> {
    return this.files.cleanupTemporaryFiles()
  }

  async deleteUnreferenced(assetId: string): Promise<{ deleted: boolean; inUse: boolean }> {
    try {
      const client = await this.dependencies.getClient()
      await client.attachments.delete(assetId)
      return { deleted: true, inUse: false }
    } catch (error) {
      if (containsErrorCode(error, "attachment_in_use")) {
        return { deleted: false, inUse: true }
      }
      throw new DesktopAttachmentServiceError(
        "attachment_delete_failed",
        "暂时无法清理这个附件。",
        true
      )
    }
  }

  async scanStorage(): Promise<AttachmentStorageReport> {
    return await (await this.dependencies.getClient()).attachments.scanStorage()
  }

  async repairStorage(): Promise<AttachmentStorageRepairResult> {
    return await (await this.dependencies.getClient()).attachments.repairStorage()
  }

  async gcStorage(): Promise<AttachmentStorageGcResult> {
    return await (await this.dependencies.getClient()).attachments.gcStorage()
  }
}

export function createAttachmentService(
  dependencies: AttachmentServiceDependencies
): DesktopAttachmentService {
  return new DesktopAttachmentService(dependencies)
}

function containsErrorCode(value: unknown, expectedCode: string): boolean {
  if (typeof value === "string") return value.includes(expectedCode)
  if (!value || typeof value !== "object") return false
  return Object.values(value).some((nested) => containsErrorCode(nested, expectedCode))
}
