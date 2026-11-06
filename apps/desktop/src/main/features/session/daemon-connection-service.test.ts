import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ServiceEndpoint } from "@vykor/application-client/service"

const sdk = vi.hoisted(() => ({
  discover: vi.fn(),
  ensure: vi.fn(),
  clientOptions: (endpoint: { url: string; token: string }) => ({ baseUrl: endpoint.url, token: endpoint.token }),
}))
const host = vi.hoisted(() => ({
  readDaemonRegistry: vi.fn(),
  readRegisteredDataLocation: vi.fn(),
  shouldStartManagedDaemon: vi.fn(),
  daemonPidAlive: vi.fn(),
  stopDaemonProcess: vi.fn(),
  getDaemonRegistryPath: () => "registry.json",
}))
const state = vi.hoisted(() => ({ browserBridge: 1 }))
vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "D:/test" },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock("@vykor/application-client/service", () => ({ Service: sdk }))
vi.mock("@vykor/server/daemon-host", () => host)
vi.mock("../daemon-autostart/daemon-autostart-service", () => ({ createDesktopDaemonSystemService: vi.fn() }))
vi.mock("@vykor/application-client", () => ({
  VykorClient: class {
    constructor(readonly options: { baseUrl: string; token: string }) {}
    protocol = { capabilities: async () => ({ features: { browserBridge: state.browserBridge } }) }
  },
}))

import { DaemonConnectionService } from "./daemon-connection-service"

const endpoint: ServiceEndpoint = {
  file: "registry.json", url: "http://127.0.0.1:5555", pid: 4242,
  token: "token", storePath: "D:/db", version: "1.0.0", startedAt: 1,
}

beforeEach(() => {
  vi.resetAllMocks()
  sdk.ensure.mockResolvedValue(endpoint)
  host.shouldStartManagedDaemon.mockResolvedValue(false)
  state.browserBridge = 1
})

describe("desktop daemon connection", () => {
  it("reuses a compatible CLI daemon and leaves it running on desktop exit", async () => {
    sdk.discover.mockResolvedValue(endpoint)
    host.readDaemonRegistry.mockReturnValue({ ...endpoint, launcher: "cli" })
    const service = new DaemonConnectionService()
    await expect(service.getClient()).resolves.toBeDefined()
    await service.dispose()
    expect(sdk.ensure).not.toHaveBeenCalled()
    expect(host.stopDaemonProcess).not.toHaveBeenCalled()
  })

  it("uses the Electron headless entry when no daemon is registered", async () => {
    const service = new DaemonConnectionService()
    await expect(service.getClient()).resolves.toBeDefined()
    expect(sdk.ensure).toHaveBeenCalledWith(expect.objectContaining({
      command: [process.execPath, "--daemon-on-demand"],
    }))
  })

  it("keeps a live unreachable registration and allows a later retry", async () => {
    host.readDaemonRegistry.mockReturnValue(endpoint)
    host.daemonPidAlive.mockReturnValue(true)
    const service = new DaemonConnectionService()
    await expect(service.getClient()).rejects.toThrow(/暂时不可达/)
    expect(sdk.ensure).not.toHaveBeenCalled()
    sdk.discover.mockResolvedValue(endpoint)
    await expect(service.getClient()).resolves.toBeDefined()
  })

  it("reports a missing desktop capability without replacing an existing daemon", async () => {
    sdk.discover.mockResolvedValue(endpoint)
    state.browserBridge = 0
    await expect(new DaemonConnectionService().getClient()).rejects.toThrow(/能力/)
    expect(host.stopDaemonProcess).not.toHaveBeenCalled()
  })

  it("reports a legacy data location mismatch instead of opening the wrong database", async () => {
    sdk.discover.mockResolvedValue(endpoint)
    host.readRegisteredDataLocation.mockResolvedValue({ directory: "D:/new", storePath: "D:/new/sessions.db" })
    await expect(new DaemonConnectionService().getClient()).rejects.toThrow(/数据/)
  })
})
