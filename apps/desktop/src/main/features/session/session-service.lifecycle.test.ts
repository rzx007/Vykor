import { beforeEach, describe, expect, it, vi } from "vitest"
const send = vi.hoisted(() => vi.fn())
vi.mock("electron", () => ({ app: { getPath: () => "D:/test", getVersion: () => "1" }, BrowserWindow: { getAllWindows: () => [{ webContents: { isDestroyed: () => false, send } }] } }))
vi.mock("../browser/browser-agent-service", () => ({ browserAgentService: {} }))
import { DesktopSessionService } from "./session-service"
import { DaemonConnectionService } from "./daemon-connection-service"
beforeEach(() => vi.clearAllMocks())
describe("retired database-only switch", () => {
  it("rejects old parameters before invalidating subscriptions or reaching the backend", async () => {
    const { service, connection } = serviceWithConnection()
    const clear = vi.spyOn(service.subscriptions, "clearAll")
    const backend = vi.spyOn(connection, "switchDataDirectory")
    await expect(service.switchDataDirectory("D:/target", { storePath: "D:/target/sessions.db" })).rejects.toThrow(/用户数据根.*迁移/)
    expect(clear).not.toHaveBeenCalled()
    expect(backend).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
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
