import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ServiceEndpoint } from "@rzx/client/service"

type Registry = ServiceEndpoint & { launcher: "desktop" | "cli"; supervised: boolean }
const state = vi.hoisted(() => ({
  registry: undefined as Registry | undefined,
  prepare: vi.fn(),
  stop: vi.fn(),
  verified: vi.fn(),
  managed: vi.fn(),
  pairing: vi.fn(),
  checkDriver: vi.fn(),
  bridge: vi.fn(),
  closed: vi.fn(),
  ensure: vi.fn(),
  alive: vi.fn(),
}))

vi.mock("electron", () => ({
  app: { getPath: () => "D:/profile", isPackaged: true },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock("@rzx/client/service", () => ({ Service: {
  discover: async () => state.registry,
  ensure: state.ensure,
  clientOptions: (value: ServiceEndpoint) => ({ baseUrl: value.url, token: value.token }),
} }))
vi.mock("@rzx/client", () => ({
  VykorClient: class { protocol = { capabilities: async () => ({ features: {} }) } },
  HttpTransport: class { request = state.prepare },
  VykorApiError: class extends Error { constructor(message: string, readonly status: number) { super(message) } },
}))
vi.mock("@vykor/host-config/paths", () => ({ getDataRoot: () => "D:/test" }))
vi.mock("@vykor/server/daemon-host", () => ({
  getDaemonRegistryPath: () => "D:/test/daemon/registry.json",
  readDaemonRegistry: () => state.registry,
  readRegisteredDataLocation: async () => ({ storePath: "D:/test/sessions.db" }),
  shouldStartManagedDaemon: state.managed,
  daemonPidAlive: state.alive,
  stopRegisteredDaemon: state.stop,
  withDaemonControlLock: (work: (signal: AbortSignal) => Promise<unknown>) => work(new AbortController().signal),
}))
vi.mock("../../daemon-autostart/daemon-autostart-service", () => ({ createDesktopDaemonSystemService: vi.fn() }))
vi.mock("../../daemon-autostart/computer-pairing", () => ({ pairDesktopComputerDaemon: state.pairing }))
vi.mock("../availability", () => ({ computerAvailability: () => "ready" }))
vi.mock("../windows-driver", () => ({
  assertBundledWindowsDriverIntegrity: state.checkDriver,
  createWindowsDriver: vi.fn(),
}))
vi.mock("../windows-daemon-identity", () => ({ isWindowsOnDemandDaemon: state.verified }))
vi.mock("../computer-bridge", () => ({
  DesktopComputerBridge: class {
    constructor(options: unknown) { state.bridge(options) }
    close = state.closed
  },
}))

import { DaemonConnectionService } from "../../session/daemon-connection-service"

const existing: Registry = {
  pid: 120, url: "http://127.0.0.1:4500", token: "original",
  startedAt: 1, version: "test", storePath: "D:/test/sessions.db", file: "D:/test/daemon/registry.json",
  launcher: "desktop", supervised: false,
}
const replacement = { ...existing, pid: 122, token: "replacement", startedAt: 2 }

beforeEach(() => {
  vi.resetAllMocks()
  state.registry = existing
  state.prepare.mockResolvedValue({ prepared: true })
  state.verified.mockImplementation(registry => registry.launcher === "desktop" && !registry.supervised)
  state.managed.mockResolvedValue(false)
  state.alive.mockReturnValue(true)
  state.stop.mockImplementation(async verify => {
    if (!await verify(state.registry)) throw new Error("Registration could not be verified.")
    state.registry = undefined
  })
  state.ensure.mockImplementation(async ({ pairSpawned, signal }) => {
    state.registry = replacement
    await pairSpawned({ pid: replacement.pid }, replacement, signal)
    return replacement
  })
  state.pairing.mockResolvedValue("private")
  state.checkDriver.mockResolvedValue(undefined)
})

describe.runIf(process.platform === "win32" && process.arch === "x64")("Desktop on-demand daemon pairing", () => {
  it("rejects a damaged bundled driver before connecting to or restarting the daemon", async () => {
    const service = new DaemonConnectionService()
    const connect = vi.spyOn(service, "getClient")
    state.checkDriver.mockRejectedValueOnce(new Error("Windows 控制驱动的校验值不符。"))
    await expect(service.getComputerBridge(() => {}, new AbortController().signal)).rejects.toThrow(/校验值不符/)
    expect(connect).not.toHaveBeenCalled()
    expect(state.prepare).not.toHaveBeenCalled()
    expect(state.bridge).not.toHaveBeenCalled()
  })

  it("blocks pending and new Computer bridge admissions once shutdown begins", async () => {
    const service = new DaemonConnectionService()
    const client = await service.getClient()
    const ready = Promise.withResolvers<typeof client>()
    vi.spyOn(service, "getClient").mockReturnValueOnce(ready.promise)
    const opening = service.getComputerBridge(() => {}, new AbortController().signal)
    await service.closeComputerAdmission()
    ready.resolve(client)
    await expect(opening).rejects.toThrow(/退出或更新/)
    await expect(service.getComputerBridge(() => {}, new AbortController().signal)).rejects.toThrow(/退出或更新/)
    expect(state.bridge).not.toHaveBeenCalled()
    expect(await service.getClient()).toBe(client)
  })
  it.each(["仍有运行或尚未收尾的任务", "仍有未关闭的临时聊天"])("preserves the ordinary client when protection rejects: %s", async message => {
    const service = new DaemonConnectionService()
    const original = await service.getClient()
    state.prepare.mockRejectedValue(new Error(message))
    await expect(service.getComputerBridge(() => {}, new AbortController().signal)).rejects.toThrow(message)
    expect(state.prepare).toHaveBeenCalledExactlyOnceWith("/maintenance/prepare-root-migration", expect.anything())
    expect(state.stop).not.toHaveBeenCalled()
    expect(state.ensure).not.toHaveBeenCalled()
    expect(await service.getClient()).toBe(original)
  })

  it("leaves independent and newly managed daemons available for ordinary chat", async () => {
    const service = new DaemonConnectionService()
    const original = await service.getClient()
    state.registry = { ...existing, launcher: "cli" }
    await expect(service.getComputerBridge(() => {}, new AbortController().signal)).rejects.toThrow(/保持运行/)
    state.registry = existing
    state.managed.mockResolvedValue(true)
    await expect(service.getComputerBridge(() => {}, new AbortController().signal)).rejects.toThrow(/保持运行/)
    expect(state.prepare).not.toHaveBeenCalled()
    expect(state.stop).not.toHaveBeenCalled()
    expect(await service.getClient()).toBe(original)
  })

  it("skips automatic pairing on unrelated daemons before entering maintenance", async () => {
    state.registry = { ...existing, launcher: "cli" }
    const service = new DaemonConnectionService()
    const original = await service.getClient()
    await expect(service.getComputerBridge(() => {}, new AbortController().signal, undefined, undefined, true))
      .rejects.toThrow(/无法完成电脑操作配对/)
    expect(state.verified).not.toHaveBeenCalled()
    expect(state.prepare).not.toHaveBeenCalled()
    expect(await service.getClient()).toBe(original)
  })

  it("waits for the verified daemon replacement before delivering another message", async () => {
    const gate = Promise.withResolvers<{ prepared: boolean }>()
    state.prepare.mockReturnValueOnce(gate.promise)
    const service = new DaemonConnectionService()
    const original = await service.getClient()
    const paired = service.getComputerBridge(() => {}, new AbortController().signal, undefined, undefined, true)
    await vi.waitFor(() => expect(state.prepare).toHaveBeenCalledOnce())
    const receipt = vi.fn()
    const waiting = service.getClient().then(receipt)
    await Promise.resolve()
    expect(receipt).not.toHaveBeenCalled()
    gate.resolve({ prepared: true })
    await paired
    await waiting
    expect(receipt).toHaveBeenCalledExactlyOnceWith(await service.getClient())
    expect(receipt.mock.calls[0]?.[0]).not.toBe(original)
    expect(state.stop).toHaveBeenCalledOnce()
  })

  it.each(["changed registration", "dead registered process"])("protects temporary chats before restart and revokes after a %s", async condition => {
    const notify = vi.fn(async () => {})
    const service = new DaemonConnectionService({ onComputerDaemonRestarted: notify })
    const original = await service.getClient()
    await service.getComputerBridge(() => {}, new AbortController().signal)
    expect(state.prepare.mock.invocationCallOrder[0]).toBeLessThan(state.stop.mock.invocationCallOrder[0]!)
    expect(state.stop).toHaveBeenCalledOnce()
    expect(state.ensure).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenCalledOnce()
    expect(await service.getClient()).not.toBe(original)
    const paired = await service.getClient()
    const [{ authorizeDaemon }] = state.bridge.mock.calls[0]!
    expect(authorizeDaemon).not.toThrow()
    if (condition === "dead registered process") state.alive.mockReturnValueOnce(false)
    else state.registry = { ...replacement, pid: 123, token: "another", startedAt: 3 }
    expect(authorizeDaemon).toThrow(/登记已变化/)
    expect(state.closed).toHaveBeenCalledOnce()
    state.registry = { ...replacement, pid: 123, token: "another", startedAt: 3 }
    expect(await service.getClient()).not.toBe(paired)
    expect(state.stop).toHaveBeenCalledOnce()
  })

  it("waits for closed readiness and confirms the PID when the preparation response is lost", async () => {
    let readiness = 0
    let originalSignal: AbortSignal | undefined
    state.prepare.mockImplementation(async (path, options) => {
      if (path === "/maintenance/prepare-root-migration") {
        originalSignal = options.signal
        throw new DOMException("lost preparation response", "TimeoutError")
      }
      if (path === "/health") return { restartPrepared: true }
      if (path === "/maintenance/readiness") return { phase: ++readiness > 1 ? "closed" : "closing" }
      if (path === "/debug/process") return { pid: existing.pid }
      throw new Error("Unexpected path: " + path)
    })
    const service = new DaemonConnectionService()
    await expect(service.getComputerBridge(() => {}, new AbortController().signal)).resolves.toBeDefined()
    expect(readiness).toBe(2)
    expect(state.stop).toHaveBeenCalledOnce()
    expect(state.verified.mock.calls[1]![1]).not.toBe(originalSignal)
  })

  it("uses the exact prepared endpoint to recover a transient second OS identity check failure", async () => {
    state.verified.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    state.prepare.mockImplementation(async (path) => {
      if (path === "/maintenance/prepare-root-migration") return { prepared: true }
      if (path === "/health") return { restartPrepared: true }
      if (path === "/maintenance/readiness") return { phase: "closed" }
      if (path === "/debug/process") return { pid: existing.pid }
      throw new Error("Unexpected path: " + path)
    })
    const service = new DaemonConnectionService()
    await expect(service.getComputerBridge(() => {}, new AbortController().signal)).resolves.toBeDefined()
    expect(state.prepare.mock.calls.map(call => call[0])).toContain("/debug/process")
    expect(state.ensure).toHaveBeenCalledOnce()
  })
})
