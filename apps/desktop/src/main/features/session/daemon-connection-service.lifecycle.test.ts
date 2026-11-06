import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ServiceEndpoint } from "@vykor/application-client/service"

const state = vi.hoisted(() => ({
  endpoint: undefined as ServiceEndpoint | undefined,
  supervised: false,
  prepare: vi.fn(async () => ({ prepared: true })),
  requestSwitch: vi.fn(),
  readSwitchResult: vi.fn(),
  result: vi.fn(),
  stop: vi.fn(),
}))
vi.mock("electron", () => ({
  app: { getPath: () => "D:/test" },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock("@vykor/application-client/service", () => ({ Service: {
  discover: async () => state.endpoint,
  clientOptions: (endpoint: ServiceEndpoint) => ({ baseUrl: endpoint.url, token: endpoint.token }),
} }))
vi.mock("@vykor/server/daemon-host", () => ({
  readDaemonRegistry: () => ({ ...state.endpoint, supervised: state.supervised }),
  readRegisteredDataLocation: async () => undefined,
  readRegisteredDataSwitchResult: state.readSwitchResult,
  getDaemonRegistryPath: () => "registry.json",
  stopDaemonProcess: state.stop,
  withDaemonControlLock: (action: (signal: AbortSignal) => Promise<unknown>) => action(new AbortController().signal),
  shouldStartManagedDaemon: async () => false,
}))
vi.mock("../daemon-autostart/daemon-autostart-service", () => ({ createDesktopDaemonSystemService: vi.fn() }))
vi.mock("@vykor/application-client", () => ({ VykorClient: class {
  protocol = { capabilities: async () => ({ features: { browserBridge: 1 } }) }
  system = { prepareRestart: state.prepare, requestDataSwitch: state.requestSwitch, getDataSwitchResult: state.result }
} }))

import { DaemonConnectionService } from "./daemon-connection-service"

let folder: string
let original: ServiceEndpoint
beforeEach(() => {
  vi.clearAllMocks()
  folder = mkdtempSync(join(tmpdir(), "vykor-desktop-switch-"))
  original = {
    file: "registry.json", pid: 42, url: "http://127.0.0.1:4000", token: "original",
    version: "1.0.0", startedAt: 1, storePath: join(folder, "original.db"),
  }
  state.endpoint = original
  state.supervised = false
})
afterEach(() => rmSync(folder, { force: true, recursive: true }))

describe("independent daemon maintenance", () => {
  it("waits for daemon approval before stopping and reattaches to a new endpoint", async () => {
    const service = new DaemonConnectionService()
    await service.getClient()
    state.stop.mockImplementationOnce(async () => {
      state.endpoint = { ...original, pid: 43, token: "replacement", startedAt: 2 }
    })
    await expect(service.restart()).resolves.toBeDefined()
    expect(state.prepare.mock.invocationCallOrder[0]).toBeLessThan(state.stop.mock.invocationCallOrder[0]!)
    expect(state.stop).toHaveBeenCalledWith(original.pid)
  })

  it("keeps the running daemon if safe preparation is rejected", async () => {
    const service = new DaemonConnectionService()
    const client = await service.getClient()
    state.prepare.mockRejectedValueOnce(new Error("仍有活动任务"))
    await expect(service.restart()).rejects.toThrow(/活动任务/)
    expect(state.stop).not.toHaveBeenCalled()
    await expect(service.getClient()).resolves.toBe(client)
  })

  it("refuses to stop a registration that changed during preparation", async () => {
    const service = new DaemonConnectionService()
    await service.getClient()
    state.prepare.mockImplementationOnce(async () => {
      state.endpoint = { ...original, pid: 43, startedAt: 2 }
      return { prepared: true }
    })
    await expect(service.restart()).rejects.toThrow(/变化/)
    expect(state.stop).not.toHaveBeenCalled()
  })

  it.each(["succeeded", "failed"])("reconnects after a data switch finishes with %s", async status => {
    const service = new DaemonConnectionService()
    const oldClient = await service.getClient()
    const storePath = join(folder, "new.db")
    writeFileSync(storePath, "")
    state.requestSwitch.mockImplementationOnce(async ({ id }) => {
      state.endpoint = {
        ...original, token: "new", startedAt: 2,
        storePath: status === "succeeded" ? storePath : original.storePath,
      }
      return { id }
    })
    state.result.mockResolvedValueOnce({ status, error: "已恢复原数据位置" })
    const result = service.switchDataDirectory(folder, { storePath })
    if (status === "succeeded") await expect(result).resolves.toBeDefined()
    else await expect(result).rejects.toThrow(/恢复原数据/)
    expect(await service.getClient()).not.toBe(oldClient)
    expect(state.stop).not.toHaveBeenCalled()
  })

  it("reconnects when the daemon accepted the switch but the response was lost", async () => {
    const service = new DaemonConnectionService()
    const oldClient = await service.getClient()
    const storePath = join(folder, "new.db")
    writeFileSync(storePath, "")
    state.requestSwitch.mockImplementationOnce(async ({ id }) => {
      state.readSwitchResult.mockResolvedValueOnce({ id, status: "pending" })
      state.endpoint = { ...original, token: "new", startedAt: 2, storePath }
      throw new Error("connection closed")
    })
    state.result.mockResolvedValueOnce({ status: "succeeded" })

    await expect(service.switchDataDirectory(folder, { storePath })).resolves.toBeDefined()
    expect(state.readSwitchResult).toHaveBeenCalledWith(state.requestSwitch.mock.calls[0]?.[0].id)
    expect(await service.getClient()).not.toBe(oldClient)
  })
})
