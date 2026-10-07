import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DaemonOperationGate } from "../../../../../../packages/server/src/application/control/daemon-operation-gate"

const state = vi.hoisted(() => ({ registry: undefined as unknown, preview: { runs: [] as unknown[], tasks: [] as unknown[], terminals: [] as unknown[] }, terminals: [] as Array<{ id: string; status: string }>, safeRestart: 0, prepareError: "", prepared: false, onPrepare: undefined as (() => void) | undefined }))
const host = vi.hoisted(() => ({
  readDaemonRegistry: vi.fn(() => state.registry), clearDaemonRegistry: vi.fn(() => { state.registry = undefined }),
  writeDaemonRegistry: vi.fn(value => { state.registry = value }), createBearerToken: () => "test-token",
  createDaemonRegistryEntry: (value: unknown) => value, startVykorDaemon: vi.fn(), shouldStartManagedDaemon: async () => false,
}))
vi.mock("electron", () => ({ app: { getVersion: () => "1", getPath: () => "D:/test" }, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock("@vykor/server/daemon-host", () => host)
vi.mock("../daemon-autostart/daemon-surface", () => ({ isDesktopManagedRegistry: (value: { executionSurface: string }) => value.executionSurface === "desktop_managed", isLoopbackDaemonUrl: (url: string) => new URL(url).hostname === "127.0.0.1" }))
vi.mock("../daemon-autostart/daemon-takeover", () => ({ stopNonDesktopDaemon: vi.fn(), reconcileDesktopManagedService: vi.fn() }))
vi.mock("@vykor/client", () => ({ VykorClient: class {
  protocol = { health: async () => ({ activeRunCount: 0, queuedRunCount: 0 }), capabilities: async () => ({ features: { safeRestart: state.safeRestart } }) }
  projects = { list: async () => [] }
  system = { getRestartPreview: async () => state.preview, prepareRestart: async () => { if (state.prepareError) throw new Error(state.prepareError); state.prepared = true; state.onPrepare?.(); return { prepared: true } } }
  terminals = { list: async () => state.terminals, close: async () => {} }
  sessions = { list: async () => [], interrupt: async () => {} }
} }))
import { DaemonConnectionService } from "./daemon-connection-service"

let directory: string
let previousDataDir: string | undefined
function fakeServer(path: string, gate = new DaemonOperationGate(), closeWait = Promise.resolve()) {
  return { store: { path }, application: { control: { acquireGlobalMutation: () => gate.tryEnterBarrier({ kind: "global" }, () => true) } },
    close: vi.fn(async () => { const drained = gate.beginShutdown(); await closeWait; await drained; gate.markClosed() }) }
}
beforeEach(() => {
  vi.clearAllMocks(); state.registry = undefined; state.preview = { runs: [], tasks: [], terminals: [] }; state.terminals = []
  state.safeRestart = 0; state.prepareError = ""; state.prepared = false; state.onPrepare = undefined
  previousDataDir = process.env.VYKOR_DATA_DIR
  directory = mkdtempSync(join(tmpdir(), "vykor-lifecycle-test-"))
})
afterEach(() => {
  if (previousDataDir === undefined) delete process.env.VYKOR_DATA_DIR; else process.env.VYKOR_DATA_DIR = previousDataDir
  rmSync(directory, { recursive: true, force: true })
})
async function embeddedService(server = fakeServer(join(directory, "original.db"))) {
  host.startVykorDaemon.mockResolvedValue({ server, listen: { url: "http://127.0.0.1:7777" } })
  const service = new DaemonConnectionService({ dataLocationPath: join(directory, "location.json") })
  await service.getClient()
  return { service, server }
}
describe("daemon lifecycle settings", () => {
  it("allows a restart after all terminal processes have exited", async () => {
    const { service } = await embeddedService()
    state.terminals = [{ id: "old", status: "completed" }, { id: "closed", status: "killed" }]
    await expect(service.restart()).resolves.toBeDefined()
  })
  it.each(["runs", "tasks", "terminals"] as const)("rejects restart while the real preview still contains active %s", async kind => {
    const { service, server } = await embeddedService()
    state.preview[kind] = [{ id: "active", status: "running" }]
    await expect(service.restart()).rejects.toThrow(/任务|终端/)
    expect(server.close).not.toHaveBeenCalled()
    state.preview[kind] = []
    await expect(service.restart()).resolves.toBeDefined()
  })
  it("refuses shutdown if a task starts after the remote idle check", async () => {
    const gate = new DaemonOperationGate()
    const { service, server } = await embeddedService(fakeServer(join(directory, "original.db"), gate))
    const work = gate.enter({ sessionId: "new-run", cwd: "D:/project" })
    await expect(service.restart()).rejects.toThrow(/任务|收尾/)
    expect(server.close).not.toHaveBeenCalled()
    work.release()
  })
  it("seals admission before releasing maintenance protection without deadlocking shutdown", async () => {
    const gate = new DaemonOperationGate()
    let releaseClose!: () => void
    const wait = new Promise<void>(resolve => { releaseClose = resolve })
    const { service, server } = await embeddedService(fakeServer(join(directory, "original.db"), gate, wait))
    const restart = service.restart()
    await vi.waitFor(() => expect(server.close).toHaveBeenCalledOnce())
    expect(() => gate.enter({ sessionId: "late", cwd: "D:/project" })).toThrow(/closing/)
    await expect(service.getClient()).rejects.toThrow(/重启|切换/)
    releaseClose()
    await expect(restart).resolves.toBeDefined()
  })
  it("serializes data switches with restart and leaves one persisted target", async () => {
    const first = join(directory, "a.db"), second = join(directory, "b.db")
    writeFileSync(first, ""); writeFileSync(second, "")
    let releaseClose!: () => void
    const wait = new Promise<void>(resolve => { releaseClose = resolve })
    const { service, server } = await embeddedService(fakeServer(join(directory, "original.db"), new DaemonOperationGate(), wait))
    const switchData = service.switchDataDirectory(directory, { storePath: first })
    await vi.waitFor(() => expect(server.close).toHaveBeenCalledOnce())
    await expect(service.switchDataDirectory(directory, { storePath: second })).rejects.toThrow(/重启|切换/)
    await expect(service.restart()).rejects.toThrow(/重启|切换/)
    releaseClose()
    await expect(switchData).resolves.toBeDefined()
    expect(JSON.parse(readFileSync(join(directory, "location.json"), "utf8")).location.storePath).toBe(first)
  })
  it("refuses to kill an external resident service that has no atomic shutdown guard", async () => {
    state.registry = { pid: 42, url: "http://127.0.0.1:8888", executionSurface: "desktop_managed" }
    const reconcile = vi.fn(async () => {})
    const service = new DaemonConnectionService({ reconcileDesktopService: reconcile, dataLocationPath: join(directory, "location.json") })
    await service.getClient()
    await expect(service.restart()).rejects.toThrow(/常驻|安全/)
    expect(reconcile).not.toHaveBeenCalled()
  })
  it("restarts a supported local resident service only after safe preparation finishes", async () => {
    state.registry = { pid: 42, url: "http://127.0.0.1:8888", token: "external", executionSurface: "desktop_managed" }
    state.safeRestart = 1
    const reconcile = vi.fn(async () => { expect(state.prepared).toBe(true); state.registry = { pid: 43, url: "http://127.0.0.1:9999", token: "next", executionSurface: "desktop_managed" } })
    const service = new DaemonConnectionService({ reconcileDesktopService: reconcile, dataLocationPath: join(directory, "location.json") })
    await service.getClient()
    await expect(service.restart()).resolves.toBeDefined()
    expect(reconcile).toHaveBeenCalledOnce()
  })
  it("never reconciles a resident service if safe preparation rejects active work", async () => {
    state.registry = { pid: 42, url: "http://127.0.0.1:8888", token: "external", executionSurface: "desktop_managed" }
    state.safeRestart = 1; state.prepareError = "后台任务尚未结束"
    const reconcile = vi.fn(async () => {})
    const service = new DaemonConnectionService({ reconcileDesktopService: reconcile, dataLocationPath: join(directory, "location.json") })
    await service.getClient()
    await expect(service.restart()).rejects.toThrow(/任务/)
    expect(reconcile).not.toHaveBeenCalled()
  })
  it("refuses resident replacement if the registry changes during preparation", async () => {
    state.registry = { pid: 42, url: "http://127.0.0.1:8888", token: "external", executionSurface: "desktop_managed" }
    state.safeRestart = 1
    state.onPrepare = () => { state.registry = { pid: 43, url: "http://127.0.0.1:9999", token: "other", executionSurface: "desktop_managed" } }
    const reconcile = vi.fn(async () => {})
    const service = new DaemonConnectionService({ reconcileDesktopService: reconcile, dataLocationPath: join(directory, "location.json") })
    await service.getClient()
    await expect(service.restart()).rejects.toThrow(/变化/)
    expect(reconcile).not.toHaveBeenCalled()
  })
  it("refuses a remote registry target even when it advertises safe restart", async () => {
    state.registry = { pid: 42, url: "https://remote.example", token: "external", executionSurface: "desktop_managed" }
    state.safeRestart = 1
    const reconcile = vi.fn(async () => {})
    const service = new DaemonConnectionService({ reconcileDesktopService: reconcile, dataLocationPath: join(directory, "location.json") })
    await service.getClient()
    await expect(service.restart()).rejects.toThrow(/本机/)
    expect(state.prepared).toBe(false); expect(reconcile).not.toHaveBeenCalled()
  })
})
