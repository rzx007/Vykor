import { createReadStream } from "node:fs"
import { lstat, mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises"
import { basename, extname, join, resolve } from "node:path"
import { Readable } from "node:stream"

import type {
  AttachmentAssetRecord,
  AttachmentStorageGcResult,
  AttachmentStorageRepairResult,
  AttachmentStorageReport,
  DownloadAttachmentOptions,
  UploadAttachmentInput,
} from "@openharness/client"

import type {
  DesktopAttachmentCandidate,
  DesktopAttachmentError,
  DesktopAttachmentUploadEvent,
} from "@shared/attachment-types"
import type { SafeImageMediaType } from "@shared/safe-image-preview"
import { evaluateInspectedImagePreview } from "../image-preview/inspect-safe-image-layout"

interface AttachmentClient {
  uploadAttachment(input: UploadAttachmentInput): Promise<AttachmentAssetRecord>
  getAttachment(id: string, options?: { signal?: AbortSignal }): Promise<AttachmentAssetRecord>
  downloadAttachment(id: string, options?: DownloadAttachmentOptions): Promise<Response>
  deleteAttachment(id: string, options?: { signal?: AbortSignal }): Promise<AttachmentAssetRecord>
  scanAttachmentStorage(options?: { signal?: AbortSignal }): Promise<AttachmentStorageReport>
  repairAttachmentStorage(options?: {
    signal?: AbortSignal
  }): Promise<AttachmentStorageRepairResult>
  gcAttachmentStorage(options?: { signal?: AbortSignal }): Promise<AttachmentStorageGcResult>
}

export interface AttachmentFileSystem {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>
  realpath(path: string): Promise<string>
  stat(path: string): Promise<{ isFile(): boolean; size: number }>
  assertReadable(path: string): Promise<void>
  createReadStream(path: string): ReturnType<typeof createReadStream>
  mkdtemp(prefix: string): Promise<string>
  writeFile(path: string, bytes: Uint8Array): Promise<void>
  rm(path: string, options: { recursive: true; force: true }): Promise<void>
}

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

export class DesktopAttachmentServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message)
    this.name = "DesktopAttachmentServiceError"
  }
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

export class DesktopAttachmentService {
  private readonly sources = new Map<string, SourceRecord>()
  private readonly tasks = new Map<string, UploadTask>()
  private readonly queue: UploadTask[] = []
  private readonly failedSources = new Map<string, SourceRecord>()
  private readonly idleWaiters = new Set<() => void>()
  private readonly managedTemporaryDirectories = new Set<string>()
  private readonly fileSystem: AttachmentFileSystem
  private running = 0

  constructor(private readonly dependencies: AttachmentServiceDependencies) {
    this.fileSystem = {
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
  }

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

  async readPreview(assetId: string): Promise<{ bytes: ArrayBuffer; mediaType: string }> {
    const client = await this.dependencies.getClient()
    const asset = await client.getAttachment(assetId)
    const mediaType = asset.mediaType ?? asset.declaredMediaType ?? "application/octet-stream"
    if (!SAFE_PREVIEW_MEDIA_TYPES.has(mediaType)) {
      throw serviceError("attachment_preview_unsupported")
    }
    const previewLimit = Math.min(this.dependencies.maxBytesPerFile, 10 * 1024 * 1024)
    if ((asset.sizeBytes ?? 0) > previewLimit) throw serviceError("attachment_preview_too_large")
    const response = await client.downloadAttachment(assetId)
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

  async deleteUnreferenced(assetId: string): Promise<{ deleted: boolean; inUse: boolean }> {
    try {
      const client = await this.dependencies.getClient()
      await client.deleteAttachment(assetId)
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
    return await (await this.dependencies.getClient()).scanAttachmentStorage()
  }

  async repairStorage(): Promise<AttachmentStorageRepairResult> {
    return await (await this.dependencies.getClient()).repairAttachmentStorage()
  }

  async gcStorage(): Promise<AttachmentStorageGcResult> {
    return await (await this.dependencies.getClient()).gcAttachmentStorage()
  }

  async openAttachment(assetId: string): Promise<void> {
    if (!this.dependencies.temporaryRoot || !this.dependencies.openPath) {
      throw serviceError("attachment_open_unavailable")
    }
    const client = await this.dependencies.getClient()
    const asset = await client.getAttachment(assetId)
    const directory = await this.fileSystem.mkdtemp(
      join(this.dependencies.temporaryRoot, "openharness-attachment-")
    )
    this.managedTemporaryDirectories.add(directory)
    const targetPath = join(directory, safeDisplayName(asset.displayName))
    try {
      const response = await client.downloadAttachment(assetId)
      const bytes = await readResponseBytes(response, this.dependencies.maxBytesPerFile)
      await this.fileSystem.writeFile(targetPath, bytes)
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
    const asset = await client.getAttachment(assetId)
    const targetPath = await this.dependencies.chooseSavePath(safeDisplayName(asset.displayName))
    if (!targetPath) return { saved: false }
    try {
      const response = await client.downloadAttachment(assetId)
      const bytes = await readResponseBytes(response, this.dependencies.maxBytesPerFile)
      await this.fileSystem.writeFile(targetPath, bytes)
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

  async whenIdle(): Promise<void> {
    if (this.running === 0 && this.queue.length === 0) return
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve))
  }

  private async stagePath(ownerId: number, path: string): Promise<DesktopAttachmentCandidate> {
    try {
      const absolutePath = resolve(path)
      const sourceInfo = await this.fileSystem.lstat(absolutePath)
      if (sourceInfo.isSymbolicLink()) throw serviceError("attachment_source_symlink")
      const canonicalPath = await this.fileSystem.realpath(absolutePath)
      const fileInfo = await this.fileSystem.stat(canonicalPath)
      if (!fileInfo.isFile()) throw serviceError("attachment_source_not_file")
      if (fileInfo.size > this.dependencies.maxBytesPerFile) {
        throw serviceError("attachment_file_too_large")
      }
      await this.fileSystem.assertReadable(canonicalPath)

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
          ? this.fileSystem.createReadStream(task.source.absolutePath)
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
      const asset = await client.uploadAttachment({
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

  private scheduleTemporaryCleanup(directory: string): void {
    const timeout = setTimeout(
      () => void this.cleanupTemporaryDirectory(directory).catch(() => undefined),
      this.dependencies.temporaryFileTtlMs ?? 60 * 60 * 1_000
    )
    timeout.unref()
  }

  private async cleanupTemporaryDirectory(directory: string): Promise<void> {
    if (!this.managedTemporaryDirectories.delete(directory)) return
    await this.fileSystem.rm(directory, { recursive: true, force: true })
  }
}

export function createAttachmentService(
  dependencies: AttachmentServiceDependencies
): DesktopAttachmentService {
  return new DesktopAttachmentService(dependencies)
}

const SAFE_PREVIEW_MEDIA_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

function taskKey(ownerId: number, taskId: string): string {
  return `${ownerId}:${taskId}`
}

function draftKey(ownerId: number, draftId: string): string {
  return `${ownerId}:${draftId}`
}

function serviceError(code: string): DesktopAttachmentServiceError {
  const messages: Record<string, string> = {
    attachment_source_expired: "文件授权已过期，请重新选择。",
    attachment_source_forbidden: "这个文件授权不属于当前窗口。",
    attachment_source_symlink: "暂不支持符号链接文件。",
    attachment_source_not_file: "只能添加普通文件，暂不支持文件夹。",
    attachment_source_unreadable: "无法读取这个文件。",
    attachment_file_too_large: "文件大小超过当前限制。",
    attachment_preview_unsupported: "这种文件不能直接预览。",
    attachment_preview_too_large: "图片太大，无法直接预览。",
    attachment_open_unavailable: "当前环境不能打开附件。",
    attachment_open_failed: "附件打开失败。",
    attachment_save_unavailable: "当前环境不能保存附件。",
    attachment_clipboard_unsupported: "剪贴板中的内容不是可上传的图片。",
    attachment_retry_unavailable: "这个附件已经不能重试，请重新添加。",
    attachment_task_exists: "附件上传任务重复。",
  }
  return new DesktopAttachmentServiceError(code, messages[code] ?? "附件操作失败。")
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

function containsErrorCode(value: unknown, expectedCode: string): boolean {
  if (typeof value === "string") return value.includes(expectedCode)
  if (!value || typeof value !== "object") return false
  return Object.values(value).some((nested) => containsErrorCode(nested, expectedCode))
}

function safeDisplayName(value: string): string {
  const printable = [...value]
    .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
    .join("")
  const safe = printable.replace(/[<>:"/\\|?*]/g, "_").trim()
  return safe || "attachment"
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

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}
