import { describe, expect, it, vi } from "vitest"
import type { IpcMainInvokeEvent } from "electron"

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "C:\\temp"), once: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openPath: vi.fn() },
  webContents: { fromId: vi.fn() },
}))

vi.mock("../session/session-service", () => ({
  desktopSessionService: { agentClient: vi.fn(), daemonTransport: vi.fn() },
}))

import { IpcChannels, IpcEvents } from "../../../shared/ipc-channels"
import {
  createAttachmentEventEmitter,
  createAttachmentIpcContribution,
  type AttachmentIpcService,
} from "./ipc"

describe("attachment IPC owner routing", () => {
  it("derives the owner from event.sender and disposes it when the sender is destroyed", async () => {
    const service = fakeService()
    const contribution = createAttachmentIpcContribution({
      getService: async () => service,
      pickPaths: vi.fn(),
    })
    const registrations = contribution.register({} as never)
    const stageDropped = registrations.find(
      (registration) => registration.channel === IpcChannels.attachmentStageDropped
    )!
    const startUpload = registrations.find(
      (registration) => registration.channel === IpcChannels.attachmentStartUpload
    )!
    let destroyed: (() => void) | undefined
    const sender = {
      id: 41,
      once: vi.fn((name: string, listener: () => void) => {
        if (name === "destroyed") destroyed = listener
      }),
    }
    const event = { sender } as unknown as IpcMainInvokeEvent

    await stageDropped.handler(event, ["C:\\private\\report.pdf"])
    await startUpload.handler(event, {
      draftId: "draft-1",
      taskId: "task-1",
      sourceToken: "source-1",
    })

    expect(service.stagePaths).toHaveBeenCalledWith(41, ["C:\\private\\report.pdf"])
    expect(service.startUpload).toHaveBeenCalledWith(41, {
      draftId: "draft-1",
      taskId: "task-1",
      sourceToken: "source-1",
    })
    expect(sender.once).toHaveBeenCalledTimes(1)
    destroyed!()
    expect(service.disposeOwner).toHaveBeenCalledWith(41)
  })

  it("sends progress only to the live webContents that owns the task", () => {
    const send = vi.fn()
    const fromId = vi.fn((ownerId: number) =>
      ownerId === 9 ? { isDestroyed: () => false, send } : undefined
    )
    const emit = createAttachmentEventEmitter(fromId)
    const event = {
      type: "progress" as const,
      draftId: "draft-1",
      taskId: "task-1",
      bytesRead: 5,
      totalBytes: 10,
    }

    emit(9, event)
    emit(10, event)

    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(IpcEvents.attachmentUploadEvent, event)
  })
})

function fakeService(): AttachmentIpcService {
  return {
    stagePaths: vi.fn(async () => []),
    uploadMemory: vi.fn(async () => ({ taskId: "task-memory" })),
    startUpload: vi.fn(async () => ({ taskId: "task-path" })),
    cancelUpload: vi.fn(async () => undefined),
    retryUpload: vi.fn(async (_ownerId, input) => ({ taskId: input.taskId })),
    discardDraft: vi.fn(async () => undefined),
    deleteUnreferenced: vi.fn(async () => ({ deleted: true, inUse: false })),
    readPreview: vi.fn(async () => ({ bytes: new ArrayBuffer(0), mediaType: "image/png" })),
    readDocumentPreview: vi.fn(async () => ({ name: "document.pdf", format: "pdf" as const, bytes: new ArrayBuffer(0) })),
    openAttachment: vi.fn(async () => undefined),
    saveAs: vi.fn(async () => ({ saved: true })),
    scanStorage: vi.fn(async () => ({ summary: {} as never, issues: [] })),
    repairStorage: vi.fn(async () => ({ expiredLeases: 0, deletedOrphanBlobs: 0, releasedBytes: 0 })),
    gcStorage: vi.fn(async () => ({
      scannedAssets: 0,
      expiredLeases: 0,
      deletedAssets: 0,
      deletedBlobs: 0,
      releasedBytes: 0,
      skipped: {} as never,
      errors: [],
    })),
    disposeOwner: vi.fn(async () => undefined),
  }
}
