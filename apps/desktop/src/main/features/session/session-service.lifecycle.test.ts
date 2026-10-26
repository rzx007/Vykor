import { beforeEach, describe, expect, it, vi } from "vitest"
const send = vi.hoisted(() => vi.fn())
vi.mock("electron", () => ({ app: { getPath: () => "D:/test", getVersion: () => "1" }, BrowserWindow: { getAllWindows: () => [{ webContents: { isDestroyed: () => false, send } }] } }))
vi.mock("../browser/browser-agent-service", () => ({ browserAgentService: {} }))
import { DesktopSessionService } from "./session-service"
import { DaemonConnectionService } from "./daemon-connection-service"
import { IpcEvents } from "../../../shared/ipc-channels"
beforeEach(() => vi.clearAllMocks())
describe("safe settings data switch subscriptions", () => {
  it("preserves current subscriptions when switch validation fails", async () => {
    const { service, connection } = serviceWithConnection()
    const clear = vi.spyOn(service.subscriptions, "clearAll")
    vi.spyOn(connection, "switchDataDirectory").mockRejectedValue(new Error("active work"))
    await expect(service.switchDataDirectory("D:/target")).rejects.toThrow("active work")
    expect(clear).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
  it("resubscribes the original data after a failed switch rolls back", async () => {
    const { service, connection, invalidate } = serviceWithConnection()
    const replacement = {} as never
    const replace = vi.spyOn(service.activitySubscriptions, "replaceClient").mockResolvedValue(undefined)
    vi.spyOn(connection, "getClient").mockResolvedValue(replacement)
    vi.spyOn(connection, "getDaemonStatus").mockReturnValue({ phase: "ready", message: "recovered", updatedAt: 1 })
    vi.spyOn(connection, "switchDataDirectory").mockImplementation(async () => {
      invalidate()
      throw new Error("recovered original data")
    })
    await expect(service.switchDataDirectory("D:/target")).rejects.toThrow("recovered original data")
    expect(replace).toHaveBeenCalledWith(replacement)
    expect(send).toHaveBeenCalledWith(IpcEvents.sessionDaemonRestarted)
    expect(send).not.toHaveBeenCalledWith(IpcEvents.sessionDataDirectoryChanged)
  })
})

function serviceWithConnection() {
  const connection = new DaemonConnectionService()
  const listeners = new Set<() => void>()
  vi.spyOn(connection, "onInvalidated").mockImplementation((listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  })
  return {
    service: new DesktopSessionService(connection),
    connection,
    invalidate: () => { for (const listener of listeners) listener() },
  }
}
