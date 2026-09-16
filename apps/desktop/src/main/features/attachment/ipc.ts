import {
  app,
  BrowserWindow,
  dialog,
  shell,
  webContents,
  type OpenDialogOptions,
  type WebContents,
} from "electron"

import type {
  CancelDesktopAttachmentUploadInput,
  DesktopAttachmentAssetInput,
  DesktopAttachmentCandidate,
  DesktopAttachmentPreview,
  DesktopAttachmentUploadEvent,
  DiscardDesktopAttachmentDraftInput,
  RetryDesktopAttachmentUploadInput,
  StartDesktopAttachmentUploadInput,
  UploadDesktopAttachmentMemoryInput,
} from "../../../shared/attachment-types"
import type {
  AttachmentStorageGcResult,
  AttachmentStorageRepairResult,
  AttachmentStorageReport,
} from "@openharness/client"
import { IpcChannels, IpcEvents } from "../../../shared/ipc-channels"
import type { IpcContribution } from "../../core/ipc/types"
import { desktopSessionService } from "../session/session-service"
import { createAttachmentService } from "./attachment-service"

export interface AttachmentIpcService {
  stagePaths(ownerId: number, paths: readonly string[]): Promise<DesktopAttachmentCandidate[]>
  uploadMemory(
    ownerId: number,
    input: {
      draftId: string
      taskId: string
      bytes: Uint8Array
      displayName: string
      mediaType: string
    }
  ): Promise<{ taskId: string }>
  startUpload(
    ownerId: number,
    input: StartDesktopAttachmentUploadInput
  ): Promise<{ taskId: string }>
  cancelUpload(ownerId: number, taskId: string): Promise<void>
  retryUpload(
    ownerId: number,
    input: RetryDesktopAttachmentUploadInput
  ): Promise<{ taskId: string }>
  discardDraft(ownerId: number, draftId: string): Promise<void>
  deleteUnreferenced(assetId: string): Promise<{ deleted: boolean; inUse: boolean }>
  readPreview(assetId: string): Promise<DesktopAttachmentPreview>
  openAttachment(assetId: string): Promise<void>
  saveAs(assetId: string): Promise<{ saved: boolean }>
  scanStorage(): Promise<AttachmentStorageReport>
  repairStorage(): Promise<AttachmentStorageRepairResult>
  gcStorage(): Promise<AttachmentStorageGcResult>
  disposeOwner(ownerId: number): Promise<void>
}

interface AttachmentIpcDependencies {
  getService(): Promise<AttachmentIpcService>
  pickPaths(sender: WebContents, kind: "files" | "images"): Promise<string[]>
}

interface EventTarget {
  isDestroyed(): boolean
  send(channel: string, event: DesktopAttachmentUploadEvent): void
}

export function createAttachmentEventEmitter(
  fromId: (ownerId: number) => EventTarget | undefined
): (ownerId: number, event: DesktopAttachmentUploadEvent) => void {
  return (ownerId, event) => {
    const target = fromId(ownerId)
    if (!target || target.isDestroyed()) return
    target.send(IpcEvents.attachmentUploadEvent, event)
  }
}

export function createAttachmentIpcContribution(
  dependencies: AttachmentIpcDependencies
): IpcContribution {
  const initializedOwners = new WeakSet<object>()

  const serviceFor = async (sender: WebContents): Promise<AttachmentIpcService> => {
    const service = await dependencies.getService()
    if (!initializedOwners.has(sender)) {
      initializedOwners.add(sender)
      sender.once("destroyed", () => void service.disposeOwner(sender.id))
    }
    return service
  }

  return {
    id: "attachment",
    register() {
      return [
        {
          channel: IpcChannels.attachmentPickFiles,
          handler: async (event) => {
            const service = await serviceFor(event.sender)
            return await service.stagePaths(
              event.sender.id,
              await dependencies.pickPaths(event.sender, "files")
            )
          },
        },
        {
          channel: IpcChannels.attachmentPickImages,
          handler: async (event) => {
            const service = await serviceFor(event.sender)
            return await service.stagePaths(
              event.sender.id,
              await dependencies.pickPaths(event.sender, "images")
            )
          },
        },
        {
          channel: IpcChannels.attachmentStageDropped,
          handler: async (event, paths) => {
            const service = await serviceFor(event.sender)
            return await service.stagePaths(event.sender.id, stringArray(paths))
          },
        },
        {
          channel: IpcChannels.attachmentUploadMemory,
          handler: async (event, value) => {
            const service = await serviceFor(event.sender)
            const input = value as UploadDesktopAttachmentMemoryInput
            return await service.uploadMemory(event.sender.id, {
              draftId: input.draftId,
              taskId: input.taskId,
              bytes: new Uint8Array(input.bytes),
              displayName: input.displayName,
              mediaType: input.mediaType,
            })
          },
        },
        {
          channel: IpcChannels.attachmentStartUpload,
          handler: async (event, input) => {
            const service = await serviceFor(event.sender)
            return await service.startUpload(
              event.sender.id,
              input as StartDesktopAttachmentUploadInput
            )
          },
        },
        {
          channel: IpcChannels.attachmentCancelUpload,
          handler: async (event, value) => {
            const service = await serviceFor(event.sender)
            const input = value as CancelDesktopAttachmentUploadInput
            await service.cancelUpload(event.sender.id, input.taskId)
          },
        },
        {
          channel: IpcChannels.attachmentRetryUpload,
          handler: async (event, value) => {
            const service = await serviceFor(event.sender)
            return await service.retryUpload(
              event.sender.id,
              value as RetryDesktopAttachmentUploadInput
            )
          },
        },
        {
          channel: IpcChannels.attachmentDiscardDraft,
          handler: async (event, value) => {
            const service = await serviceFor(event.sender)
            await service.discardDraft(
              event.sender.id,
              (value as DiscardDesktopAttachmentDraftInput).draftId
            )
          },
        },
        {
          channel: IpcChannels.attachmentDeleteUnreferenced,
          handler: async (event, value) => {
            const service = await serviceFor(event.sender)
            return await service.deleteUnreferenced((value as DesktopAttachmentAssetInput).assetId)
          },
        },
        {
          channel: IpcChannels.attachmentReadPreview,
          handler: async (event, value) => {
            const service = await serviceFor(event.sender)
            return await service.readPreview((value as DesktopAttachmentAssetInput).assetId)
          },
        },
        {
          channel: IpcChannels.attachmentOpen,
          handler: async (event, value) => {
            const service = await serviceFor(event.sender)
            await service.openAttachment((value as DesktopAttachmentAssetInput).assetId)
          },
        },
        {
          channel: IpcChannels.attachmentSaveAs,
          handler: async (event, value) => {
            const service = await serviceFor(event.sender)
            return await service.saveAs((value as DesktopAttachmentAssetInput).assetId)
          },
        },
        {
          channel: IpcChannels.attachmentStorageScan,
          handler: async (event) => await (await serviceFor(event.sender)).scanStorage(),
        },
        {
          channel: IpcChannels.attachmentStorageRepair,
          handler: async (event) => await (await serviceFor(event.sender)).repairStorage(),
        },
        {
          channel: IpcChannels.attachmentStorageGc,
          handler: async (event) => await (await serviceFor(event.sender)).gcStorage(),
        },
      ]
    },
  }
}

let defaultServicePromise: Promise<AttachmentIpcService> | null = null

const defaultEventEmitter = createAttachmentEventEmitter((ownerId) => {
  const target = webContents.fromId(ownerId)
  return target ?? undefined
})

async function getDefaultService(): Promise<AttachmentIpcService> {
  defaultServicePromise ??= createDefaultService()
  return await defaultServicePromise
}

async function createDefaultService(): Promise<AttachmentIpcService> {
  const client = await desktopSessionService.daemonClient()
  const capabilities = await client.protocol.capabilities()
  const maxBytesPerFile = capabilities.attachments?.limits.maxBytesPerFile ?? 100 * 1024 * 1024
  const service = createAttachmentService({
    sourceTokenTtlMs: 5 * 60 * 1_000,
    maxBytesPerFile,
    getClient: () => desktopSessionService.daemonClient(),
    emit: defaultEventEmitter,
    temporaryRoot: app.getPath("temp"),
    openPath: (path) => shell.openPath(path),
    chooseSavePath: async (displayName) => {
      const result = await dialog.showSaveDialog({ defaultPath: displayName })
      return result.canceled ? null : (result.filePath ?? null)
    },
  })
  app.once("before-quit", () => void service.cleanupTemporaryFiles())
  return service
}

async function pickPaths(sender: WebContents, kind: "files" | "images"): Promise<string[]> {
  const owner = BrowserWindow.fromWebContents(sender) ?? undefined
  const options: OpenDialogOptions = {
    title: kind === "images" ? "添加图片" : "添加文件",
    properties: ["openFile", "multiSelections"],
    ...(kind === "images"
      ? {
          filters: [
            {
              name: "图片",
              extensions: ["avif", "bmp", "gif", "jpeg", "jpg", "png", "webp"],
            },
          ],
        }
      : {}),
  }
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? [] : result.filePaths
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return []
  return value
}

export const attachmentIpcContribution = createAttachmentIpcContribution({
  getService: getDefaultService,
  pickPaths,
})
