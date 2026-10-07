import { beforeEach, describe, expect, it, vi } from "vitest"
const send = vi.hoisted(() => vi.fn())
vi.mock("electron", () => ({ app: { getPath: () => "D:/test", getVersion: () => "1" }, BrowserWindow: { getAllWindows: () => [{ webContents: { isDestroyed: () => false, send } }] } }))
vi.mock("../browser/browser-agent-service", () => ({ browserAgentService: {} }))
import { DesktopSessionService } from "./session-service"
import { IpcEvents } from "../../../shared/ipc-channels"
beforeEach(() => vi.clearAllMocks())
describe("safe settings data switch subscriptions", () => {
  it("preserves current subscriptions when switch validation fails", async () => {
    const service = new DesktopSessionService()
    const clear = vi.spyOn(service.subscriptions, "clearAll")
    vi.spyOn(service.connection, "switchDataDirectory").mockRejectedValue(new Error("active work"))
    await expect(service.switchDataDirectory("D:/target")).rejects.toThrow("active work")
    expect(clear).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
  it("resubscribes the original data after a failed switch rolls back", async () => {
    const service = new DesktopSessionService()
    const replacement = {} as never
    const replace = vi.spyOn(service.activitySubscriptions, "replaceClient").mockResolvedValue(undefined)
    vi.spyOn(service.connection, "getClient").mockResolvedValue(replacement)
    vi.spyOn(service.connection, "getDaemonStatus").mockReturnValue({ phase: "ready", message: "recovered", updatedAt: 1 })
    vi.spyOn(service.connection, "switchDataDirectory").mockImplementation(async () => {
      ;(service.connection as unknown as { invalidateClient(): void }).invalidateClient()
      throw new Error("recovered original data")
    })
    await expect(service.switchDataDirectory("D:/target")).rejects.toThrow("recovered original data")
    expect(replace).toHaveBeenCalledWith(replacement)
    expect(send).toHaveBeenCalledWith(IpcEvents.sessionDaemonRestarted)
    expect(send).not.toHaveBeenCalledWith(IpcEvents.sessionDataDirectoryChanged)
  })
})
