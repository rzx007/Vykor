import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { app, BrowserWindow } from "electron"
import { VykorClient } from "@vykor/application-client"
import { Service, type ServiceEndpoint } from "@vykor/application-client/service"
import {
  daemonPidAlive,
  getDaemonRegistryPath,
  readDaemonRegistry,
  readRegisteredDataLocation,
  readRegisteredDataSwitchResult,
  reconcileDaemonSystemServiceForConnection,
  shouldStartManagedDaemon,
  stopDaemonProcess,
  withDaemonControlLock,
  type DaemonRegistry,
} from "@vykor/server/daemon-host"
import { createDesktopDaemonSystemService } from "../daemon-autostart/daemon-autostart-service"
import { isLoopbackDaemonUrl } from "../daemon-autostart/daemon-surface"
import { IpcEvents } from "../../../shared/ipc-channels"
import type { DesktopDaemonStatus, DesktopDaemonStatusPhase } from "../../../shared/session-types"

const probeTimeoutMs = 10_000
const startupTimeoutMs = 45_000

export interface DaemonConnectionServiceOptions {
  onConnected?: (endpoint: ServiceEndpoint) => () => void
}

export class DaemonConnectionService {
  private clientPromise: Promise<VykorClient> | null = null
  private connectionAbort?: AbortController
  private endpoint?: ServiceEndpoint
  private stopBrowserBridge?: () => void
  private readonly invalidationListeners = new Set<() => void>()
  private daemonStatus: DesktopDaemonStatus = {
    phase: "idle", message: "等待连接 daemon", updatedAt: Date.now(),
  }
  private restarting = false

  constructor(private readonly options: DaemonConnectionServiceOptions = {}) {}

  getDaemonStatus(): DesktopDaemonStatus {
    return this.daemonStatus
  }

  getClient(): Promise<VykorClient> {
    if (this.restarting) return Promise.reject(new Error("后台服务正在重启或切换数据，请稍候。"))
    return this.getOrConnectClient()
  }

  private getOrConnectClient(): Promise<VykorClient> {
    if (!this.clientPromise) {
      const controller = new AbortController()
      this.connectionAbort = controller
      this.clientPromise = this.connect(controller.signal).catch((error: unknown) => {
        if (this.connectionAbort === controller) {
          this.clientPromise = null
          this.setDaemonStatus("error", "后台连接失败", { detail: errorMessage(error) })
        }
        throw error
      })
    }
    return this.clientPromise
  }

  refreshClient(): Promise<VykorClient> {
    if (this.restarting) return this.getClient()
    this.invalidateClient()
    return this.getClient()
  }

  async restart(options: { stopActive?: boolean } = {}): Promise<VykorClient> {
    this.beginMaintenance()
    try {
      const endpoint = await Service.discover({ file: getDaemonRegistryPath(), timeoutMs: probeTimeoutMs })
      if (!endpoint) {
        this.invalidateClient()
        return await this.getOrConnectClient()
      }
      const client = new VykorClient(Service.clientOptions(endpoint))
      const registry = this.requireLocalRegistry(endpoint)
      const supervised = registry.supervised ?? await shouldStartManagedDaemon()
      await withDaemonControlLock(async (signal) => {
        if (!sameRegistration(registry, readDaemonRegistry()))
          throw new Error("后台连接已变化，请重新连接后重试。")
        if (options.stopActive) await this.stopActiveWork(client)
        if ((await client.system.prepareRestart({
          signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        })).prepared !== true) throw new Error("后台未确认安全收尾。")
        if (!sameRegistration(registry, readDaemonRegistry()))
          throw new Error("后台连接在准备期间发生变化，请重新连接后重试。")
        this.invalidateClient()
        if (supervised && await shouldStartManagedDaemon()) {
          const systemService = createDesktopDaemonSystemService()
          systemService.stop()
          if (sameRegistration(registry, readDaemonRegistry())) await stopDaemonProcess(registry.pid)
          systemService.start()
        } else {
          await stopDaemonProcess(registry.pid)
        }
      })
      if (supervised && await shouldStartManagedDaemon())
        return this.useEndpoint(await this.waitForReplacement(registry))
      return await this.getOrConnectClient()
    } finally {
      this.restarting = false
    }
  }

  async switchDataDirectory(
    directory: string,
    options: { stopActive?: boolean; storePath?: string } = {},
  ): Promise<VykorClient> {
    this.beginMaintenance()
    try {
      if (!isAbsolute(directory)) throw new Error("数据目录必须是完整路径。")
      const target = resolve(directory)
      const storePath = resolve(options.storePath ?? join(target, "session-runtime", "sessions.db"))
      const offset = relative(target, storePath)
      if (offset.startsWith("..") || isAbsolute(offset)) throw new Error("数据库必须位于所选数据目录内。")
      if (!existsSync(storePath)) throw new Error("请先恢复并校验目标数据库，再切换数据目录。")
      const client = await this.getOrConnectClient()
      const registry = this.requireLocalRegistry()
      if (await shouldStartManagedDaemon())
        throw new Error("请先停用系统常驻服务，再切换数据目录。")
      if (options.stopActive) await this.stopActiveWork(client)
      const id = randomUUID()
      try {
        await client.system.requestDataSwitch({ id, directory: target, storePath }, { signal: AbortSignal.timeout(60_000) })
      } catch (error) {
        // The response can be lost after the daemon has durably accepted the switch.
        if (!await readRegisteredDataSwitchResult(id).catch(() => undefined)) throw error
      }
      this.invalidateClient()
      let endpoint: ServiceEndpoint
      try {
        endpoint = await this.waitForReplacement(registry)
      } catch (error) {
        const result = await readRegisteredDataSwitchResult(id).catch(() => undefined)
        if (result?.status === "rollback_failed")
          throw new Error([result.error, result.rollbackError].filter(Boolean).join("；"))
        throw error
      }
      const next = await this.useEndpoint(endpoint)
      const result = await next.system.getDataSwitchResult(id)
      if (result.status !== "succeeded") {
        const detail = [result.error, result.rollbackError].filter(Boolean).join("；")
        throw new Error(detail || "数据切换未完成。")
      }
      return next
    } finally {
      this.restarting = false
    }
  }

  dispose(): Promise<void> {
    this.invalidateClient()
    return Promise.resolve()
  }

  /** Called after Desktop's final business export; no reconnect is allowed in this pinned process. */
  async freezeForDataRootMigration(): Promise<void> {
    this.beginMaintenance()
    const pending = this.clientPromise
    this.invalidateClient()
    await pending?.catch(() => undefined)
  }

  onInvalidated(listener: () => void): () => void {
    this.invalidationListeners.add(listener)
    return () => { this.invalidationListeners.delete(listener) }
  }

  private beginMaintenance(): void {
    if (this.restarting) throw new Error("后台服务正在重启或切换数据，请稍候。")
    this.restarting = true
  }

  private requireLocalRegistry(endpoint = this.endpoint): DaemonRegistry {
    const registry = readDaemonRegistry()
    if (!registry || !isLoopbackDaemonUrl(registry.url)) throw new Error("需要已登记的本机后台服务。")
    if (!endpoint || !sameRegistration(endpoint, registry))
      throw new Error("后台连接已变化，请重新连接后重试。")
    return registry
  }

  private async stopActiveWork(client: VykorClient): Promise<void> {
    const preview = await client.system.getRestartPreview()
    const sessions = new Set([...preview.runs, ...preview.tasks].map((item) => item.sessionId))
    for (const sessionId of sessions) await client.sessions.interrupt(sessionId, { source: "system" })
    for (const terminal of await client.terminals.list()) {
      if (["pending", "running", "stopping"].includes(terminal.status))
        await client.terminals.close(terminal.id)
    }
  }

  private invalidateClient(): void {
    this.connectionAbort?.abort()
    this.connectionAbort = undefined
    this.stopBrowserBridge?.()
    this.stopBrowserBridge = undefined
    this.endpoint = undefined
    this.clientPromise = null
    for (const listener of this.invalidationListeners) listener()
  }

  private async connect(signal: AbortSignal): Promise<VykorClient> {
    this.setDaemonStatus("discovering", "正在查找 daemon")
    const file = getDaemonRegistryPath()
    const beforeProbe = readDaemonRegistry()
    const existing = await Service.discover({ file, timeoutMs: probeTimeoutMs, signal })
    if (existing) return await this.useEndpoint(existing, signal)
    const registry = readDaemonRegistry()
    if (registry && daemonPidAlive(registry.pid)) {
      if (!beforeProbe || !sameRegistration(beforeProbe, registry)) {
        const published = await Service.discover({ file, timeoutMs: probeTimeoutMs, signal })
        if (published) return this.useEndpoint(published, signal)
      }
      throw new Error("已登记的后台暂时不可达，请稍后重试。")
    }
    this.setDaemonStatus("starting", "正在启动独立 daemon")
    if (await shouldStartManagedDaemon()) {
      signal.throwIfAborted()
      const { autoStart } = await reconcileDaemonSystemServiceForConnection(createDesktopDaemonSystemService())
      if (autoStart)
        return this.useEndpoint(await this.waitForReplacement(undefined, signal), signal)
    }
    const command = app.isPackaged
      ? [process.execPath, "--daemon-on-demand"]
      : [process.execPath, app.getAppPath(), "--daemon-on-demand"]
    const logPath = join(dirname(dirname(file)), "logs", "daemon.log")
    return this.useEndpoint(await Service.ensure({ file, command, timeoutMs: startupTimeoutMs, signal, logPath }), signal)
  }

  private async useEndpoint(endpoint: ServiceEndpoint, signal?: AbortSignal): Promise<VykorClient> {
    this.setDaemonStatus("connecting", "正在连接已运行的 daemon", { url: endpoint.url })
    const client = new VykorClient(Service.clientOptions(endpoint))
    const timeout = AbortSignal.timeout(probeTimeoutMs)
    const capabilities = await client.protocol.capabilities({
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if ((capabilities.features.browserBridge ?? 0) < 1)
      throw new Error("当前后台缺少桌面所需能力，请先安全停止旧后台，再重新连接。")
    const expected = await readRegisteredDataLocation(undefined, join(app.getPath("userData"), "runtime-data-location.json"))
    if (expected && (!endpoint.storePath || relative(expected.storePath, endpoint.storePath)))
      throw new Error("当前后台使用其他数据目录。请先停止后台，再从桌面重新连接。")
    signal?.throwIfAborted()
    this.stopBrowserBridge?.()
    this.stopBrowserBridge = this.options.onConnected?.(endpoint)
    this.endpoint = endpoint
    this.setDaemonStatus("ready", "daemon 已连接", { url: endpoint.url })
    this.clientPromise = Promise.resolve(client)
    return client
  }

  private async waitForReplacement(previous?: DaemonRegistry, signal?: AbortSignal): Promise<ServiceEndpoint> {
    const file = getDaemonRegistryPath()
    const timeout = AbortSignal.timeout(startupTimeoutMs)
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      while (!deadline.aborted) {
        const endpoint = await Service.discover({ file, timeoutMs: startupTimeoutMs, signal: deadline })
        if (endpoint && (!previous || !sameRegistration(previous, endpoint))) return endpoint
        await delay(100, undefined, { signal: deadline })
      }
    } catch (error) {
      if (!timeout.aborted) throw error
    }
    throw new Error("等待后台就绪超时，请重新连接。")
  }

  private setDaemonStatus(
    phase: DesktopDaemonStatusPhase,
    message: string,
    options: { detail?: string; url?: string } = {},
  ): void {
    this.daemonStatus = { phase, message, ...options, updatedAt: Date.now() }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed())
        window.webContents.send(IpcEvents.sessionDaemonStatusChanged, this.daemonStatus)
    }
  }
}

function sameRegistration(
  left: Pick<DaemonRegistry, "pid" | "url" | "token" | "startedAt">,
  right: Pick<DaemonRegistry, "pid" | "url" | "token" | "startedAt"> | undefined,
): boolean {
  return Boolean(right && left.pid === right.pid && left.url === right.url
    && left.token === right.token && left.startedAt === right.startedAt)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
