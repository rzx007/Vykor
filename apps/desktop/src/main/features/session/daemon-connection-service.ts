import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { app, BrowserWindow } from "electron"
import { HttpTransport, VykorApiError, VykorClient } from "@rzx/client"
import { Service, type ServiceEndpoint } from "@rzx/client/service"
import { getDataRoot } from "@vykor/host-config/paths"
import {
  daemonPidAlive,
  getDaemonRegistryPath,
  readDaemonRegistry,
  readRegisteredDataLocation,
  readRegisteredDataSwitchResult,
  reconcileDaemonSystemServiceForConnection,
  shouldStartManagedDaemon,
  stopDaemonProcess,
  stopRegisteredDaemon,
  withDaemonControlLock,
  type DaemonRegistry,
} from "@vykor/server/daemon-host"
import { createDesktopDaemonSystemService } from "../daemon-autostart/daemon-autostart-service"
import { pairDesktopComputerDaemon } from "../daemon-autostart/computer-pairing"
import { isLoopbackDaemonUrl } from "../daemon-autostart/daemon-surface"
import { DesktopComputerBridge } from "../computer/computer-bridge"
import { ComputerHost } from "../computer/computer-host"
import { createWindowsApps } from "../computer/windows-apps"
import { assertBundledWindowsDriverIntegrity, createWindowsDriver } from "../computer/windows-driver"
import type { ComputerInteraction } from "../computer/interaction"
import { computerAvailability } from "../computer/availability"
import { isWindowsOnDemandDaemon } from "../computer/windows-daemon-identity"
import { createWindowsForeground } from "../computer/windows-foreground"
import { TerminalResource } from "../terminal/terminal-resource"
import { IpcEvents } from "../../../shared/ipc-channels"
import type { DesktopDaemonStatus, DesktopDaemonStatusPhase } from "../../../shared/session-types"
import { DaemonMaintenanceResource } from "./daemon-maintenance-resource"

// The daemon's Windows capability check can spend 10 seconds in wsl.exe.
const probeTimeoutMs = 15_000
const startupTimeoutMs = 45_000
type ComputerPairing = { endpoint: ServiceEndpoint; token: string }

export interface DaemonConnectionServiceOptions {
  onConnected?: (endpoint: ServiceEndpoint) => () => void
  onComputerDaemonRestarted?: (client: VykorClient) => Promise<void>
}

export class DaemonConnectionService {
  private clientPromise: Promise<VykorClient> | null = null
  private connectionAbort?: AbortController
  private connection?: { endpoint: ServiceEndpoint; client: VykorClient; transport?: HttpTransport }
  private stopBrowserBridge?: () => void
  private computerPairing?: ComputerPairing
  private pairingRestart?: Promise<void>
  private computerBridge?: DesktopComputerBridge
  private computerHost?: ComputerHost
  private computerInputCleanup = Promise.resolve(true)
  private computerAdmissionClosed = false
  private computerOwner?: { signal: AbortSignal; revoke: () => void }
  private readonly invalidationListeners = new Set<() => void>()
  private daemonStatus: DesktopDaemonStatus = {
    phase: "idle", message: "等待连接 daemon", updatedAt: Date.now(),
  }
  private restarting = false

  constructor(private readonly options: DaemonConnectionServiceOptions = {}) {}

  getDaemonStatus(): DesktopDaemonStatus {
    return this.daemonStatus
  }

  yieldComputerInputToBrowser(sessionId: string): Promise<boolean> {
    return this.computerHost?.yieldInputToBrowser(sessionId) ?? this.computerInputCleanup
  }

  getClient(): Promise<VykorClient> {
    if (this.pairingRestart) return this.pairingRestart.catch(() => {}).then(() => this.getClient())
    if (this.restarting) return Promise.reject(new Error("后台服务正在重启或切换数据，请稍候。"))
    return this.getOrConnectClient()
  }

  async getTransport(client?: VykorClient): Promise<HttpTransport> {
    const agent = client ?? await this.getClient()
    if (this.restarting) throw new Error("后台服务正在重启或切换数据，请稍候。")
    return this.connectedTransport(agent)
  }

  revokeComputerRun(sessionId: string, runId?: string): void {
    this.computerBridge?.revoke(sessionId, runId)
  }

  invalidateComputerView(nextSessionId?: string): void {
    this.computerBridge?.invalidateView(nextSessionId)
  }

  pauseComputer(sessionId: string, runId: string): boolean {
    return this.computerHost?.pause(sessionId, runId) ?? false
  }

  async resumeComputer(sessionId: string, runId: string): Promise<boolean> {
    return await this.computerHost?.resume(sessionId, runId) ?? false
  }

  async setComputerCapture(sessionId: string, runId: string, enabled: boolean): Promise<boolean> {
    if (!this.computerHost?.setCaptureEnabled(sessionId, enabled, runId)) return false
    return enabled || (await this.computerBridge?.invalidateCapturedImage(sessionId, runId) ?? true)
  }

  async confirmComputerCleanup(sessionId: string, runId: string): Promise<boolean> {
    const [released, revoked] = await Promise.all([
      this.computerHost?.waitForInputRelease() ?? this.computerInputCleanup,
      this.computerBridge?.invalidateCapturedImage(sessionId, runId),
    ])
    return released && revoked !== false
  }

  disconnectComputer(): Promise<boolean> {
    this.closeComputerBridge()
    return this.computerInputCleanup
  }

  closeComputerAdmission(): Promise<boolean> {
    this.computerAdmissionClosed = true
    return this.disconnectComputer()
  }

  revokeComputerApp(appId: string): void {
    const run = this.computerHost?.runUsingRememberedApp(appId)
    if (run) this.revokeComputerRun(run.sessionId, run.runId)
  }

  async replyComputerApproval(sessionId: string, requestId: string, status: "approved" | "denied"): Promise<void> {
    if (!this.computerBridge) throw new Error("这次电脑操作的审批已失效。")
    await this.computerBridge.replyApproval(sessionId, requestId, status)
  }

  async getComputerBridge(
    authorizeOwner: () => void,
    ownerSignal: AbortSignal,
    onControlledReset?: () => void,
    interaction?: ComputerInteraction,
    automatic?: true,
  ): Promise<DesktopComputerBridge> {
    const assertOpen = () => {
      if (this.computerAdmissionClosed) throw new Error("Desktop 正在退出或更新，电脑操作已关闭。")
    }
    const authorize = () => {
      assertOpen()
      const availability = computerAvailability()
      if (availability !== "ready") throw new Error({
        unsupported: "此电脑操作需要 Windows x64 Desktop。",
        disabled: "当前 Desktop 未启用电脑操作。",
        missing_driver: "电脑操作驱动不完整。请重新安装经过核验的版本。",
      }[availability])
      authorizeOwner()
    }
    authorize()
    if (!automatic || !this.computerBridge) await assertBundledWindowsDriverIntegrity(ownerSignal)
    authorize()
    const client = await this.getClient()
    authorize()
    const connection = this.connection
    if (!connection || connection.client !== client) throw new Error("后台连接已变化，请重试。")
    if (!this.computerPairing) {
      if (automatic) {
        const registry = this.requireLocalRegistry(connection.endpoint)
        if (registry.launcher !== "desktop" || registry.supervised !== false || await shouldStartManagedDaemon())
          throw new Error("当前后台无法完成电脑操作配对。")
        authorize()
      }
      if (!this.computerPairing) {
        this.pairingRestart ??= this.restartForComputerPairing(connection.endpoint, authorize, onControlledReset)
          .finally(() => { this.pairingRestart = undefined })
        await this.pairingRestart
      }
    }
    authorize()
    const pairing = this.computerPairing
    if (!pairing || !this.connection || !sameComputerEndpoint(this.connection.endpoint, pairing.endpoint))
      throw new Error("当前后台无法为电脑操作完成私有配对。")
    const authorizeDaemon = () => this.assertComputerRegistration(pairing)
    authorizeDaemon()
    ownerSignal.throwIfAborted()
    if (this.computerOwner?.signal !== ownerSignal) {
      this.closeComputerBridge()
      const revoke = () => this.closeComputerBridge()
      ownerSignal.addEventListener("abort", revoke, { once: true })
      this.computerOwner = { signal: ownerSignal, revoke }
    }
    if (!this.computerBridge) {
      const host = interaction && new ComputerHost(
        createWindowsApps(), {
          ...interaction,
          invalidateCapturedImage: (sessionId, runId) => this.computerBridge?.invalidateCapturedImage(sessionId, runId),
        }, createWindowsDriver, createWindowsForeground(), this.computerInputCleanup,
      )
      this.computerHost = host
      this.computerBridge = new DesktopComputerBridge({
        baseUrl: pairing.endpoint.url,
        daemonPid: pairing.endpoint.pid,
        daemonToken: pairing.endpoint.token,
        computerToken: pairing.token,
        authorizeDaemon,
        onDaemonIdentityMismatch: () => this.invalidateComputerPairing(pairing),
        ...(host ? {
          execute: (event, signal, connection, approve, authorizeDispatch, automatic) =>
            host.execute(event, signal, connection, approve, authorizeDispatch, automatic),
          cancel: (sessionId, runId) => { host.pause(sessionId, runId) },
          revoke: (sessionId, runId) => host.revoke(sessionId, runId),
        } : {}),
      })
    }
    return this.computerBridge
  }

  private assertComputerRegistration(pairing: ComputerPairing): void {
    if (this.computerPairing === pairing) {
      try {
        const current = readDaemonRegistry(pairing.endpoint.file)
        if (this.connection && sameComputerEndpoint(this.connection.endpoint, pairing.endpoint) &&
            !relative(getDaemonRegistryPath(), pairing.endpoint.file) &&
            sameComputerEndpoint(pairing.endpoint, current) &&
            current?.launcher === "desktop" && current.supervised === false &&
            daemonPidAlive(current.pid)) return
      } catch {
        // Missing or invalid registration revokes the Computer connection.
      }
      this.invalidateComputerPairing(pairing)
    }
    throw new Error("后台登记已变化，电脑操作连接已停用。请重新打开会话后重试。")
  }

  private invalidateComputerPairing(pairing: ComputerPairing): void {
    if (this.computerPairing !== pairing) return
    this.computerPairing = undefined
    this.invalidateClient()
  }

  private async restartForComputerPairing(
    endpoint: ServiceEndpoint, authorize: () => void, onControlledReset?: () => void
  ): Promise<void> {
    this.beginMaintenance()
    let client: VykorClient
    try {
      const registry = this.requireLocalRegistry(endpoint)
      const file = getDaemonRegistryPath()
      const transport = new HttpTransport(Service.clientOptions(endpoint))
      await withDaemonControlLock(async controllerSignal => {
        const signal = AbortSignal.any([controllerSignal, AbortSignal.timeout(60_000)])
        const expected = await readRegisteredDataLocation()
        const verified = await isWindowsOnDemandDaemon(registry, signal)
        if (!expected || relative(expected.storePath, registry.storePath) ||
            !sameComputerEndpoint(endpoint, registry) || !verified || await shouldStartManagedDaemon())
          throw new Error("现有后台需要保持运行，无法为电脑操作重新配对。")
        const current = readDaemonRegistry(file)
        if (relative(file, getDaemonRegistryPath()) || !sameComputerEndpoint(endpoint, current) ||
          current?.launcher !== "desktop" || current.supervised !== false)
          throw new Error("后台登记在核对期间发生变化，请重试。")
        authorize()
        const maintenance = new DaemonMaintenanceResource(transport)
        try {
          // This uses the daemon's atomic restart barrier, including in-memory chats.
          if ((await maintenance.prepareRestartWithTemporaryChatProtection(signal)).prepared !== true)
            throw new Error("后台未确认安全收尾。")
        } catch (error) {
          if (error instanceof VykorApiError && error.status < 500) throw error
          if (!(error instanceof VykorApiError || error instanceof TypeError ||
            (error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name)))) throw error
          // The response can be lost after the daemon sealed admission and started to close.
          const recovery = AbortSignal.any([controllerSignal, AbortSignal.timeout(8_000)])
          const recovered = await this.confirmPreparedRestart(endpoint, maintenance, recovery).catch(() => false)
          if (!recovered) throw error
        }
        onControlledReset?.()
        this.invalidateClient()
        await stopRegisteredDaemon(async candidate => {
          if (!sameComputerEndpoint(endpoint, candidate) ||
            candidate.launcher !== "desktop" || candidate.supervised !== false) return false
          const verification = AbortSignal.any([controllerSignal, AbortSignal.timeout(6_500)])
          if (await isWindowsOnDemandDaemon(candidate, verification)) return true
          // The earlier OS check identified the owner. A completed restart and the
          // exact PID on its authenticated endpoint also verify a transient CIM failure.
          const fallback = AbortSignal.any([controllerSignal, AbortSignal.timeout(3_000)])
          return maintenance.isPreparedRestartComplete(candidate.pid, fallback).catch(() => false)
        }, file)
      })
      client = await this.getOrConnectClient()
    } finally {
      this.restarting = false
    }
    await this.options.onComputerDaemonRestarted?.(client)
  }

  private async confirmPreparedRestart(
    endpoint: ServiceEndpoint, maintenance: DaemonMaintenanceResource, signal: AbortSignal
  ): Promise<boolean> {
    while (!signal.aborted && sameComputerEndpoint(endpoint, readDaemonRegistry(endpoint.file))) {
      if (await maintenance.isPreparedRestartComplete(endpoint.pid, signal).catch(() => false)) return true
      await delay(100, undefined, { signal })
    }
    return false
  }

  private connectedTransport(client: VykorClient): HttpTransport {
    const connection = this.connection
    if (connection?.client !== client) throw new Error("后台连接已变化，请重新连接后重试。")
    return connection.transport ??= new HttpTransport(Service.clientOptions(connection.endpoint))
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
      const registry = this.requireLocalRegistry(endpoint)
      const supervised = registry.supervised ?? await shouldStartManagedDaemon()
      await withDaemonControlLock(async (signal) => {
        if (!sameRegistration(registry, readDaemonRegistry()))
          throw new Error("后台连接已变化，请重新连接后重试。")
        const clientOptions = Service.clientOptions(endpoint)
        const transport = new HttpTransport(clientOptions)
        if (options.stopActive) await this.stopActiveWork(new VykorClient(clientOptions), transport)
        if ((await new DaemonMaintenanceResource(transport).prepareRestart({
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
      const transport = this.connectedTransport(client)
      if (options.stopActive) await this.stopActiveWork(client, transport)
      const id = randomUUID()
      try {
        await new DaemonMaintenanceResource(transport).requestDataSwitch({ id, directory: target, storePath }, { signal: AbortSignal.timeout(60_000) })
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
      const result = await new DaemonMaintenanceResource(this.connectedTransport(next)).getDataSwitchResult(id)
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
    this.computerPairing = undefined
    this.invalidateClient()
    return this.computerInputCleanup.then(() => {})
  }

  /** Called after Desktop's final business export; no reconnect is allowed in this pinned process. */
  async freezeForDataRootMigration(): Promise<void> {
    this.beginMaintenance()
    const pending = this.clientPromise
    this.computerPairing = undefined
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

  private requireLocalRegistry(endpoint = this.connection?.endpoint): DaemonRegistry {
    const registry = readDaemonRegistry()
    if (!registry || !isLoopbackDaemonUrl(registry.url)) throw new Error("需要已登记的本机后台服务。")
    if (!endpoint || !sameRegistration(endpoint, registry))
      throw new Error("后台连接已变化，请重新连接后重试。")
    return registry
  }

  private async stopActiveWork(client: VykorClient, transport: HttpTransport): Promise<void> {
    const preview = await new DaemonMaintenanceResource(transport).getRestartPreview()
    const sessions = new Set([...preview.runs, ...preview.tasks].map((item) => item.sessionId))
    for (const sessionId of sessions) await client.sessions.interrupt(sessionId, { source: "system" })
    const terminals = new TerminalResource(transport)
    for (const terminal of await terminals.list()) {
      if (["pending", "running", "stopping"].includes(terminal.status))
        await terminals.close(terminal.id)
    }
  }

  private invalidateClient(): void {
    this.connectionAbort?.abort()
    this.connectionAbort = undefined
    this.stopBrowserBridge?.()
    this.stopBrowserBridge = undefined
    this.closeComputerBridge()
    this.connection = undefined
    this.clientPromise = null
    for (const listener of this.invalidationListeners) listener()
  }

  private closeComputerBridge(): void {
    this.computerBridge?.close()
    if (this.computerHost) this.computerInputCleanup = this.computerHost.waitForInputRelease()
    this.computerBridge = undefined
    this.computerHost = undefined
    if (this.computerOwner)
      this.computerOwner.signal.removeEventListener("abort", this.computerOwner.revoke)
    this.computerOwner = undefined
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
    // Electron resolves session data before loading JavaScript. Reuse the
    // desktop profile when Windows cannot resolve the default roaming path.
    if (process.platform === "win32") command.push(`--user-data-dir=${app.getPath("userData")}`)
    const logPath = join(dirname(dirname(file)), "logs", "daemon.log")
    const endpoint = await Service.ensure({
      file, command, timeoutMs: startupTimeoutMs, signal, logPath,
      ...(process.platform === "win32" && process.arch === "x64" ? {
        pairSpawned: async (child, candidate, startupSignal) => {
          const token = await pairDesktopComputerDaemon(child, candidate, getDataRoot(), startupSignal)
          if (token) this.computerPairing = { endpoint: candidate, token }
        },
      } : {}),
    })
    return this.useEndpoint(endpoint, signal)
  }

  private async useEndpoint(endpoint: ServiceEndpoint, signal?: AbortSignal): Promise<VykorClient> {
    this.setDaemonStatus("connecting", "正在连接已运行的 daemon", { url: endpoint.url })
    const client = new VykorClient(Service.clientOptions(endpoint))
    const timeout = AbortSignal.timeout(probeTimeoutMs)
    const capabilities = await client.protocol.capabilities({
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    const expected = await readRegisteredDataLocation(undefined, join(app.getPath("userData"), "runtime-data-location.json"))
    if (expected && (!endpoint.storePath || relative(expected.storePath, endpoint.storePath)))
      throw new Error("当前后台使用其他数据目录。请先停止后台，再从桌面重新连接。")
    signal?.throwIfAborted()
    if (this.computerPairing && !sameComputerEndpoint(endpoint, this.computerPairing.endpoint)) {
      this.computerPairing = undefined
      this.closeComputerBridge()
    }
    this.stopBrowserBridge?.()
    this.stopBrowserBridge = undefined
    if ((capabilities.features.browserBridge ?? 0) >= 1)
      this.stopBrowserBridge = this.options.onConnected?.(endpoint)
    this.connection = { endpoint, client }
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

function sameComputerEndpoint(endpoint: ServiceEndpoint, candidate: Pick<ServiceEndpoint, "pid" | "url" | "token" | "startedAt" | "version" | "storePath"> | undefined): boolean {
  return sameRegistration(endpoint, candidate) && endpoint.version === candidate?.version &&
    Boolean(endpoint.storePath && candidate.storePath && !relative(endpoint.storePath, candidate.storePath))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
