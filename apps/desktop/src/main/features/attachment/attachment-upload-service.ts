import { basename, extname, resolve } from "node:path"
import { Readable } from "node:stream"

import type { DesktopAttachmentCandidate, DesktopAttachmentError, DesktopAttachmentUploadEvent } from "@shared/attachment-types"

import {
  SAFE_PREVIEW_MEDIA_TYPES,
  type AttachmentClient,
  type AttachmentFileSystem,
  DesktopAttachmentServiceError,
  safeDisplayName,
  serviceError,
} from "./attachment-support"

interface SourceMetadata {
  ownerId: number
  displayName: string
  declaredMediaType: string
  sizeBytes: number
  expiresAt: number
}

type SourceRecord = SourceMetadata &
  ({ kind: "path"; absolutePath: string } | { kind: "memory"; bytes: Uint8Array })

interface UploadTask {
  ownerId: number
  taskId: string
  draftId: string
  source: SourceRecord
  state: "queued" | "running" | "cancelled"
  controller: AbortController
  stream: Readable | null
}

export interface StartAttachmentUploadInput {
  draftId: string
  sourceToken: string
  taskId?: string
}

type UploadTaskEvent =
  | { type: "progress"; bytesRead: number; totalBytes: number }
  | {
    type: "success"
    assetId: string
    displayName: string
    mediaType: string
    sizeBytes: number
  }
  | { type: "failed"; error: DesktopAttachmentError }
  | { type: "cancelled" }

export interface UploadMemoryAttachmentInput {
  draftId: string
  taskId?: string
  displayName: string
  mediaType: string
  bytes: Uint8Array
}

export interface AttachmentUploadServiceDependencies {
  sourceTokenTtlMs: number
  maxBytesPerFile: number
  emit(ownerId: number, event: DesktopAttachmentUploadEvent): void
  getClient(): Promise<AttachmentClient>
  now?: () => number
  fileSystem: AttachmentFileSystem
  onOpenSource?: (path: string) => void
}

export class AttachmentUploadService {
  private readonly sources = new Map<string, SourceRecord>()
  private readonly tasks = new Map<string, UploadTask>()
  private readonly queue: UploadTask[] = []
  private readonly failedSources = new Map<string, SourceRecord>()
  private readonly idleWaiters = new Set<() => void>()
  private running = 0

  constructor(private readonly dependencies: AttachmentUploadServiceDependencies) {}

  async stagePaths(
    ownerId: number,
    paths: readonly string[]
  ): Promise<DesktopAttachmentCandidate[]> {
    const candidates: DesktopAttachmentCandidate[] = []
    try {
      for (const path of paths) candidates.push(await this.stagePath(ownerId, path))
      return candidates
    } catch (error) {
      for (const candidate of candidates) this.sources.delete(candidate.sourceToken)
      throw error
    }
  }

  async startUpload(
    ownerId: number,
    input: StartAttachmentUploadInput
  ): Promise<{ taskId: string }> {
    const source = this.sources.get(input.sourceToken)
    if (!source || source.expiresAt <= this.now()) {
      this.sources.delete(input.sourceToken)
      throw serviceError("attachment_source_expired")
    }
    if (source.ownerId !== ownerId) throw serviceError("attachment_source_forbidden")

    this.sources.delete(input.sourceToken)
    const taskId = input.taskId ?? crypto.randomUUID()
    this.enqueue(ownerId, input.draftId, taskId, source)
    return { taskId }
  }

  async cancelUpload(ownerId: number, taskId: string): Promise<void> {
    const key = taskKey(ownerId, taskId)
    const task = this.tasks.get(key)
    if (!task || task.state === "cancelled") return
    task.state = "cancelled"
    task.controller.abort()
    task.stream?.destroy()
    const queuedIndex = this.queue.indexOf(task)
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1)
      this.tasks.delete(key)
    }
    this.emit(task, { type: "cancelled" })
    this.pumpQueue()
    this.resolveIdleIfNeeded()
  }

  async uploadMemory(
    ownerId: number,
    input: UploadMemoryAttachmentInput
  ): Promise<{ taskId: string }> {
    if (!SAFE_PREVIEW_MEDIA_TYPES.has(input.mediaType)) {
      throw serviceError("attachment_clipboard_unsupported")
    }
    if (input.bytes.byteLength > this.dependencies.maxBytesPerFile) {
      throw serviceError("attachment_file_too_large")
    }
    const taskId = input.taskId ?? crypto.randomUUID()
    this.enqueue(ownerId, input.draftId, taskId, {
      kind: "memory",
      ownerId,
      bytes: input.bytes,
      displayName: safeDisplayName(input.displayName),
      declaredMediaType: input.mediaType,
      sizeBytes: input.bytes.byteLength,
      expiresAt: this.now(),
    })
    return { taskId }
  }

  async retryUpload(
    ownerId: number,
    input: { draftId: string; taskId: string }
  ): Promise<{ taskId: string }> {
    const key = draftKey(ownerId, input.draftId)
    const source = this.failedSources.get(key)
    if (!source) throw serviceError("attachment_retry_unavailable")
    this.failedSources.delete(key)
    this.enqueue(ownerId, input.draftId, input.taskId, {
      ...source,
      expiresAt: this.now() + this.dependencies.sourceTokenTtlMs,
    })
    return { taskId: input.taskId }
  }

  async discardDraft(ownerId: number, draftId: string): Promise<void> {
    this.failedSources.delete(draftKey(ownerId, draftId))
  }

  async disposeOwner(ownerId: number): Promise<void> {
    for (const [token, source] of this.sources) {
      if (source.ownerId === ownerId) this.sources.delete(token)
    }
    for (const [key, source] of this.failedSources) {
      if (source.ownerId === ownerId) this.failedSources.delete(key)
    }
    const ownerTasks = [...this.tasks.values()].filter((task) => task.ownerId === ownerId)
    await Promise.all(ownerTasks.map((task) => this.cancelUpload(ownerId, task.taskId)))
  }

  async whenIdle(): Promise<void> {
    if (this.running === 0 && this.queue.length === 0) return
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve))
  }

  private async stagePath(ownerId: number, path: string): Promise<DesktopAttachmentCandidate> {
    try {
      const absolutePath = resolve(path)
      const sourceInfo = await this.dependencies.fileSystem.lstat(absolutePath)
      if (sourceInfo.isSymbolicLink()) throw serviceError("attachment_source_symlink")
      const canonicalPath = await this.dependencies.fileSystem.realpath(absolutePath)
      const fileInfo = await this.dependencies.fileSystem.stat(canonicalPath)
      if (!fileInfo.isFile()) throw serviceError("attachment_source_not_file")
      if (fileInfo.size > this.dependencies.maxBytesPerFile) {
        throw serviceError("attachment_file_too_large")
      }
      await this.dependencies.fileSystem.assertReadable(canonicalPath)

      const displayName = safeDisplayName(basename(canonicalPath))
      const sourceToken = crypto.randomUUID()
      const draftId = crypto.randomUUID()
      const declaredMediaType = inferMediaType(displayName)
      this.sources.set(sourceToken, {
        kind: "path",
        ownerId,
        absolutePath: canonicalPath,
        displayName,
        declaredMediaType,
        sizeBytes: fileInfo.size,
        expiresAt: this.now() + this.dependencies.sourceTokenTtlMs,
      })
      return { draftId, sourceToken, displayName, declaredMediaType, sizeBytes: fileInfo.size }
    } catch (error) {
      if (error instanceof DesktopAttachmentServiceError) throw error
      throw serviceError("attachment_source_unreadable")
    }
  }

  private pumpQueue(): void {
    while (this.running < 3 && this.queue.length > 0) {
      const task = this.queue.shift()!
      if (task.state === "cancelled") continue
      task.state = "running"
      this.running += 1
      void this.runUpload(task)
    }
    this.resolveIdleIfNeeded()
  }

  private async runUpload(task: UploadTask): Promise<void> {
    let bytesRead = 0
    let lastProgressAt = 0
    try {
      const nodeStream =
        task.source.kind === "path"
          ? this.dependencies.fileSystem.createReadStream(task.source.absolutePath)
          : Readable.from([task.source.bytes])
      if (task.source.kind === "path") {
        this.dependencies.onOpenSource?.(task.source.absolutePath)
      }
      task.stream = nodeStream
      task.controller.signal.addEventListener("abort", () => nodeStream.destroy(), { once: true })
      const source = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>
      const body = source.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform: (chunk, controller) => {
            bytesRead += chunk.byteLength
            const now = this.now()
            if (now - lastProgressAt >= 100 || bytesRead === task.source.sizeBytes) {
              lastProgressAt = now
              this.emit(task, {
                type: "progress",
                bytesRead,
                totalBytes: task.source.sizeBytes,
              })
            }
            controller.enqueue(chunk)
          },
        })
      )
      const client = await this.dependencies.getClient()
      const asset = await client.attachments.upload({
        displayName: task.source.displayName,
        mediaType: task.source.declaredMediaType,
        body,
        signal: task.controller.signal,
      })
      if (task.state !== "cancelled" && !task.controller.signal.aborted) {
        this.failedSources.delete(draftKey(task.ownerId, task.draftId))
        this.emit(task, {
          type: "success",
          assetId: asset.id,
          displayName: asset.displayName,
          mediaType: asset.mediaType ?? asset.declaredMediaType ?? task.source.declaredMediaType,
          sizeBytes: asset.sizeBytes ?? task.source.sizeBytes,
        })
      }
    } catch (error) {
      if (task.state !== "cancelled" && !task.controller.signal.aborted) {
        this.failedSources.set(draftKey(task.ownerId, task.draftId), task.source)
        this.emit(task, { type: "failed", error: toPublicError(error) })
      }
    } finally {
      task.stream?.destroy()
      this.tasks.delete(taskKey(task.ownerId, task.taskId))
      this.running -= 1
      this.pumpQueue()
    }
  }

  private emit(task: UploadTask, event: UploadTaskEvent): void {
    this.dependencies.emit(task.ownerId, {
      ...event,
      draftId: task.draftId,
      taskId: task.taskId,
    })
  }

  private resolveIdleIfNeeded(): void {
    if (this.running !== 0 || this.queue.length !== 0) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }

  private enqueue(ownerId: number, draftId: string, taskId: string, source: SourceRecord): void {
    const key = taskKey(ownerId, taskId)
    if (this.tasks.has(key)) throw serviceError("attachment_task_exists")
    const task: UploadTask = {
      ownerId,
      taskId,
      draftId,
      source,
      state: "queued",
      controller: new AbortController(),
      stream: null,
    }
    this.tasks.set(key, task)
    this.queue.push(task)
    this.pumpQueue()
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now()
  }
}

function taskKey(ownerId: number, taskId: string): string {
  return `${ownerId}:${taskId}`
}

function draftKey(ownerId: number, draftId: string): string {
  return `${ownerId}:${draftId}`
}

function toPublicError(error: unknown): DesktopAttachmentError {
  if (error instanceof DesktopAttachmentServiceError) {
    return { code: error.code, message: error.message, retryable: error.retryable }
  }
  return {
    code: "attachment_upload_failed",
    message: "附件上传失败，请重试。",
    retryable: true,
  }
}

function inferMediaType(fileName: string): string {
  const extension = extname(fileName).toLowerCase()
  const mediaTypes: Record<string, string> = {
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".json": "application/json",
    ".md": "text/markdown",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".txt": "text/plain",
    ".webp": "image/webp",
  }
  return mediaTypes[extension] ?? "application/octet-stream"
}
