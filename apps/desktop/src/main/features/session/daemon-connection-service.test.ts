import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ServiceEndpoint } from "@rzx/client/service"

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
  reconcileDaemonSystemServiceForConnection: vi.fn(),
  withDaemonControlLock: (action: (signal: AbortSignal) => unknown) => action(new AbortController().signal),
  getDaemonRegistryPath: () => "registry.json",
}))
const systemService = vi.hoisted(() => ({
  status: () => ({ platform: "win32", state: "running", detail: "ready" }),
  start: vi.fn(),
}))
const state = vi.hoisted(() => ({ capabilities: vi.fn(), transportCreated: vi.fn() }))
vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "D:/test profile" },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock("@rzx/client/service", () => ({ Service: sdk }))
vi.mock("@vykor/server/daemon-host", () => host)
vi.mock("../daemon-autostart/daemon-autostart-service", () => ({ createDesktopDaemonSystemService: () => systemService }))
vi.mock("@rzx/client", () => ({
  VykorClient: class {
    constructor(readonly options: { baseUrl: string; token: string }) {}
    protocol = { capabilities: state.capabilities }
    sessions = { list: async () => [] }
  },
  HttpTransport: class {
    constructor(readonly options: { baseUrl: string; token: string }) { state.transportCreated(options) }
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
  state.capabilities.mockResolvedValue({ features: { browserBridge: 1 } })
})

describe("desktop daemon connection", () => {
  it("reuses a compatible CLI daemon and leaves it running on desktop exit", async () => {
    sdk.discover.mockResolvedValue(endpoint)
    host.readDaemonRegistry.mockReturnValue({ ...endpoint, launcher: "cli" })
    const service = new DaemonConnectionService()
    await expect(service.getClient()).resolves.toBeDefined()
    await service.dispose()
    expect(state.transportCreated).not.toHaveBeenCalled()
    expect(sdk.ensure).not.toHaveBeenCalled()
    expect(host.stopDaemonProcess).not.toHaveBeenCalled()
  })

  it("shares the management transport and rejects an earlier connection after refresh", async () => {
    sdk.discover.mockResolvedValue(endpoint)
    const service = new DaemonConnectionService()
    const client = await service.getClient()
    const transport = await service.getTransport(client)
    await expect(service.getTransport()).resolves.toBe(transport)
    expect(state.transportCreated).toHaveBeenCalledExactlyOnceWith({ baseUrl: endpoint.url, token: endpoint.token })

    const replacement = { ...endpoint, token: "new-token" }
    sdk.discover.mockResolvedValue(replacement)
    const next = await service.refreshClient()
    await expect(service.getTransport(client)).rejects.toThrow(/连接已变化/)
    await expect(service.getTransport(next)).resolves.not.toBe(transport)
    expect(state.transportCreated).toHaveBeenLastCalledWith({ baseUrl: replacement.url, token: replacement.token })
  })

  it("passes the desktop profile to the Windows Electron daemon when no daemon is registered", async () => {
    const service = new DaemonConnectionService()
    await expect(service.getClient()).resolves.toBeDefined()
    expect(sdk.ensure).toHaveBeenCalledWith(expect.objectContaining({
      command: [
        process.execPath,
        "--daemon-on-demand",
        ...(process.platform === "win32" ? ["--user-data-dir=D:/test profile"] : []),
      ],
    }))
  })

  it("asks the shared startup policy to kick the idle Windows task before waiting", async () => {
    host.shouldStartManagedDaemon.mockResolvedValue(true)
    host.reconcileDaemonSystemServiceForConnection.mockImplementation(async () => {
      systemService.start()
      return { autoStart: true, state: "running", action: "started" }
    })
    sdk.discover.mockResolvedValueOnce(undefined).mockResolvedValueOnce(endpoint)

    await expect(new DaemonConnectionService().getClient()).resolves.toBeDefined()
    expect(systemService.start).toHaveBeenCalledOnce()
    expect(host.reconcileDaemonSystemServiceForConnection).toHaveBeenCalledWith(systemService)
    expect(sdk.ensure).not.toHaveBeenCalled()
  })

  it("uses on-demand startup if the setting changed before managed startup", async () => {
    host.shouldStartManagedDaemon.mockResolvedValue(true)
    host.reconcileDaemonSystemServiceForConnection.mockResolvedValue({
      autoStart: false, state: "not-installed", action: "none",
    })

    await expect(new DaemonConnectionService().getClient()).resolves.toBeDefined()
    expect(systemService.start).not.toHaveBeenCalled()
    expect(sdk.ensure).toHaveBeenCalledOnce()
  })

  it("connects to a managed daemon whose first capability probe takes more than one second", async () => {
    vi.useFakeTimers()
    const service = new DaemonConnectionService()
    let connection: Promise<string> | undefined
    try {
      host.shouldStartManagedDaemon.mockResolvedValue(true)
      host.reconcileDaemonSystemServiceForConnection.mockResolvedValue({ autoStart: true })
      sdk.discover.mockResolvedValueOnce(undefined).mockImplementation(({ timeoutMs, signal }) =>
        new Promise((resolve) => {
          const finish = (value: ServiceEndpoint | undefined) => {
            clearTimeout(timer)
            signal.removeEventListener("abort", abort)
            resolve(value)
          }
          const abort = () => finish(undefined)
          const timer = setTimeout(() => finish(timeoutMs >= 1_200 ? endpoint : undefined), Math.min(timeoutMs, 1_200))
          signal.addEventListener("abort", abort, { once: true })
        })
      )
      connection = service.getClient().then(() => "ready", () => "failed")
      await vi.advanceTimersByTimeAsync(1_500)
      expect(await Promise.race([connection, Promise.resolve("pending")])).toBe("ready")
    } finally {
      await service.dispose()
      await connection
      vi.useRealTimers()
    }
  })

  it("connects to an existing daemon after a cold Windows capability check", async () => {
    host.readDaemonRegistry.mockReturnValue(endpoint)
    host.daemonPidAlive.mockReturnValue(true)
    // WSL discovery can spend 10 seconds in wsl.exe before the daemon sends its response.
    sdk.discover.mockImplementation(async ({ timeoutMs }) =>
      timeoutMs > 10_200 ? endpoint : undefined,
    )

    const service = new DaemonConnectionService()
    await expect(service.getClient()).resolves.toBeDefined()
    expect(service.getDaemonStatus().phase).toBe("ready")
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

  it("reads sessions from a compatible daemon with no browser bridge", async () => {
    sdk.discover.mockResolvedValue(endpoint)
    host.readDaemonRegistry.mockReturnValue({ ...endpoint, launcher: "cli" })
    host.readRegisteredDataLocation.mockResolvedValue({ directory: "D:/", storePath: endpoint.storePath })
    state.capabilities.mockResolvedValue({ features: {} })
    const onConnected = vi.fn()
    const service = new DaemonConnectionService({ onConnected })

    const client = await service.getClient()
    await expect(client.sessions.list()).resolves.toEqual([])
    expect(service.getDaemonStatus().phase).toBe("ready")
    expect(onConnected).not.toHaveBeenCalled()
    expect(sdk.ensure).not.toHaveBeenCalled()
    expect(host.stopDaemonProcess).not.toHaveBeenCalled()
  })

  it("releases the old bridge and starts a new one only for a daemon advertising it", async () => {
    const headless = { ...endpoint, token: "headless" }
    const replacement = { ...endpoint, token: "replacement" }
    sdk.discover.mockResolvedValueOnce(endpoint).mockResolvedValueOnce(headless).mockResolvedValueOnce(replacement)
    state.capabilities.mockResolvedValueOnce({ features: { browserBridge: 1 } })
      .mockResolvedValueOnce({ features: {} })
      .mockResolvedValueOnce({ features: { browserBridge: 1 } })
    const firstStop = vi.fn()
    const replacementStop = vi.fn()
    const onConnected = vi.fn().mockReturnValueOnce(firstStop).mockReturnValueOnce(replacementStop)
    const service = new DaemonConnectionService({ onConnected })

    await service.getClient()
    expect(onConnected).toHaveBeenCalledExactlyOnceWith(endpoint)
    await service.refreshClient()
    expect(firstStop).toHaveBeenCalledOnce()
    expect(onConnected).toHaveBeenCalledTimes(1)
    await service.refreshClient()
    expect(onConnected).toHaveBeenNthCalledWith(2, replacement)
    await service.dispose()
    expect(firstStop).toHaveBeenCalledOnce()
    expect(replacementStop).toHaveBeenCalledOnce()
  })

  it("keeps rejecting a daemon when protocol negotiation fails", async () => {
    sdk.discover.mockResolvedValue(endpoint)
    const error = new Error("incompatible protocol")
    state.capabilities.mockRejectedValue(error)
    const onConnected = vi.fn()
    const service = new DaemonConnectionService({ onConnected })

    await expect(service.getClient()).rejects.toBe(error)
    expect(onConnected).not.toHaveBeenCalled()
    expect(service.getDaemonStatus().phase).toBe("error")
  })

  it("reports a legacy data location mismatch instead of opening the wrong database", async () => {
    sdk.discover.mockResolvedValue(endpoint)
    host.readRegisteredDataLocation.mockResolvedValue({ directory: "D:/new", storePath: "D:/new/sessions.db" })
    const onConnected = vi.fn()
    await expect(new DaemonConnectionService({ onConnected }).getClient()).rejects.toThrow(/数据/)
    expect(onConnected).not.toHaveBeenCalled()
  })
})
