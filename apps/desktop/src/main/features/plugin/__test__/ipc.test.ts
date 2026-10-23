import { describe, expect, it, vi } from "vitest"
import type { IpcMainInvokeEvent } from "electron"

const electron = vi.hoisted(() => ({ app: { once: vi.fn() } }))

vi.mock("electron", () => electron)
vi.mock("../plugin-service", () => ({ desktopPluginService: {} }))

import { IpcChannels } from "../../../../shared/ipc-channels"
import { createPluginIpcContribution } from "../ipc"

describe("plugin archive IPC", () => {
  it("binds marketplace confirmation to its sender and strips forged install fields", async () => {
    const service = { marketplace: { confirm: vi.fn(), preview: vi.fn() } }
    const registrations = createPluginIpcContribution(service as never).register({} as never)
    const confirm = registrations.find(item => item.channel === IpcChannels.marketplaceConfirm)!
    const sender = { id: 42 }
    await confirm.handler({ sender } as IpcMainInvokeEvent, { cwd: "C:/workspace", selectionId: "opaque", candidateId: "forged", approvedPermissions: ["process:spawn"], allowSourceChange: true })
    expect(service.marketplace.confirm).toHaveBeenCalledWith(sender, { cwd: "C:/workspace", selectionId: "opaque" })
  })
  it("passes the invoking sender to the native chooser and exposes only high-level confirmation inputs", async () => {
    const service = {
      importArchive: vi.fn(async () => ({ status: "cancelled" as const })),
      confirmArchive: vi.fn(async () => ({ status: "installed" as const })),
      cancelArchive: vi.fn(async () => undefined),
      clearArchiveSelections: vi.fn(),
    }
    const contribution = createPluginIpcContribution(service as never)
    const registrations = contribution.register({} as never)
    const importArchive = registrations.find(({ channel }) => channel === IpcChannels.pluginImportArchive)!
    const confirmArchive = registrations.find(({ channel }) => channel === IpcChannels.pluginConfirmArchive)!
    const cancelArchive = registrations.find(({ channel }) => channel === IpcChannels.pluginCancelArchive)!
    const sender = { id: 23 }
    const event = { sender } as unknown as IpcMainInvokeEvent

    await importArchive.handler(event, { cwd: "C:/workspace", archivePath: "C:/forged.zip" })
    await confirmArchive.handler(event, {
      cwd: "C:/workspace",
      selectionId: "selection-1",
      permissions: ["process:spawn"],
      archivePath: "C:/forged.zip",
      archiveDigest: "forged",
    })
    await cancelArchive.handler(event, { selectionId: "selection-1", cwd: "C:/workspace" })

    expect(service.importArchive).toHaveBeenCalledWith(sender, { cwd: "C:/workspace" })
    expect(service.confirmArchive).toHaveBeenCalledWith({ cwd: "C:/workspace", selectionId: "selection-1" })
    expect(service.cancelArchive).toHaveBeenCalledWith({ selectionId: "selection-1" })
  })

  it("clears pending archive selections when the app quits", () => {
    const clearArchiveSelections = vi.fn()
    const contribution = createPluginIpcContribution({ clearArchiveSelections } as never)

    contribution.register({} as never)
    const cleanup = electron.app.once.mock.calls
      .findLast(([event]) => event === "before-quit")?.[1]
    cleanup()

    expect(clearArchiveSelections).toHaveBeenCalledOnce()
  })

  it("discards retired bundled IDs and renderer-supplied archive paths", async () => {
    const service = { importArchive: vi.fn(async () => ({ status: "cancelled" as const })) }
    const registrations = createPluginIpcContribution(service as never).register({} as never)
    const handler = registrations.find(({ channel }) => channel === IpcChannels.pluginImportArchive)!
    const sender = { id: 24 }
    await handler.handler({ sender } as unknown as IpcMainInvokeEvent, {
      cwd: "C:/workspace", bundledPlugin: "knowledge-work", archivePath: "C:/forged.zip",
    })
    expect(service.importArchive).toHaveBeenCalledWith(sender, {
      cwd: "C:/workspace",
    })
  })
})
