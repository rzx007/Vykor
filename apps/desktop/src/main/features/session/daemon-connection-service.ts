import { app, BrowserWindow } from "electron"
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { VykorClient } from "@vykor/client"
import { type BrowserHost, type VykorHttpServer } from "@vykor/server"
import {
  clearDaemonRegistry,
  createBearerToken,
  createDaemonRegistryEntry,
  readDaemonRegistry,
  shouldStartManagedDaemon,
  startVykorDaemon,
  writeDaemonRegistry,
  type DaemonRegistry,
} from "@vykor/server/daemon-host"

import { isDesktopManagedRegistry, isLoopbackDaemonUrl } from "../daemon-autostart/daemon-surface"
import {
  reconcileDesktopManagedService,
  stopNonDesktopDaemon,
} from "../daemon-autostart/daemon-takeover"
import { IpcEvents } from "../../../shared/ipc-channels"
import type { DesktopDaemonStatus, DesktopDaemonStatusPhase } from "../../../shared/session-types"
import { buildOutsideProjectRoot } from "./outside-project-workspace"

/**
 * Cold starts can take several seconds: the first `/capabilities` handshake has
 * been observed taking 5-6s. A too-short timeout makes a healthy daemon look
 * "unavailable", which previously caused the registry to be cleared and a second
 * daemon to fight the still-alive owner. Keep this comfortably above handshake
 * latency.
 */
const DEFAULT_VERIFY_TIMEOUT_MS = 10_000

export interface DaemonConnectionServiceOptions {
  dataLocationPath?: string
  /** Process liveness check; injectable for tests. Defaults to `process.kill(pid, 0)`. */
  pidAlive?: (pid: number) => boolean
  /** How long to wait for a registered daemon to answer before giving up. */
  verifyTimeoutMs?: number
  /** Whether the OS auto-start service is enabled (daemon.autoStart). */
  shouldAutoStart?: () => Promise<boolean>
  /** Stop a live, non-desktop-managed local daemon. */
  stopNonDesktopDaemon?: (registry: DaemonRegistry) => Promise<void>
  /** Reconcile the OS service so it starts a desktop-managed daemon. */
  reconcileDesktopService?: (registry: DaemonRegistry) => Promise<void>
  browserHost?: BrowserHost
}

export class DaemonConnectionService {
  private clientPromise: Promise<VykorClient> | null = null
  private readonly invalidationListeners = new Set<() => void>()
  private embeddedServer: VykorHttpServer | null = null
  private embeddedUrl: string | null = null
  private daemonStatus: DesktopDaemonStatus = createDaemonStatus("idle", "等待连接 daemon")
  private readonly pidAlive: (pid: number) => boolean
  private readonly verifyTimeoutMs: number
  private readonly shouldAutoStart: () => Promise<boolean>
  private readonly stopNonDesktopDaemon: (registry: DaemonRegistry) => Promise<void>
  private readonly reconcileDesktopService: (registry: DaemonRegistry) => Promise<void>
  private readonly browserHost?: BrowserHost
  private dataLocation: { directory: string; storePath?: string } | null = null
  private restarting = false
  private readonly dataLocationPath: () => string

  constructor(options: DaemonConnectionServiceOptions = {}) {
    this.pidAlive = options.pidAlive ?? isPidAlive
    this.verifyTimeoutMs = options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS
    this.shouldAutoStart = options.shouldAutoStart ?? (async () => await shouldStartManagedDaemon())
    this.stopNonDesktopDaemon = options.stopNonDesktopDaemon ?? stopNonDesktopDaemon
    this.reconcileDesktopService = options.reconcileDesktopService ?? reconcileDesktopManagedService
    this.browserHost = options.browserHost
    this.dataLocationPath = () => options.dataLocationPath ?? join(app.getPath("userData"), "runtime-data-location.json")
  }

  getDaemonStatus(): DesktopDaemonStatus {
    return this.daemonStatus
  }

  getClient(): Promise<VykorClient> {
    if (this.restarting) return Promise.reject(new Error("后台服务正在重启或切换数据，请稍候。"))
    return this.getOrConnectClient()
  }

  private getOrConnectClient(): Promise<VykorClient> {
    if (!this.clientPromise) {
      // Do not cache a rejection: a transient failure (e.g. a cold-start
      // handshake timeout) must be retryable without restarting the app.
      this.clientPromise = this.connect().catch((error: unknown) => {
        this.clientPromise = null
        throw error
      })
    }
    return this.clientPromise
  }

  refreshClient(): Promise<VykorClient> {
    if (this.restarting) return Promise.reject(new Error("后台服务正在重启或切换数据，请稍候。"))
    this.invalidateClient()
    this.clientPromise = null
    return this.getClient()
  }

  async restart(options: { stopActive?: boolean } = {}): Promise<VykorClient> {
    if (this.restarting) throw new Error("后台服务正在重启或切换数据，请稍候。")
    this.restarting = true
    try {
      const client = await this.getOrConnectClient()
      if (!this.embeddedServer) {
        const registry = readDaemonRegistry()
        if (!registry || !isDesktopManagedRegistry(registry) || !isLoopbackDaemonUrl(registry.url)) throw new Error("当前后台不是本机桌面托管服务，不能安全重启。")
        const capabilities = await client.protocol.capabilities()
        if ((capabilities.features.safeRestart ?? 0) < 1) throw new Error("当前常驻后台版本未提供安全重启接口，请先对齐后台版本。")
        if (options.stopActive) await this.stopActiveWork(client)
        const prepared = await client.system.prepareRestart({ signal: AbortSignal.timeout(60_000) })
        if (prepared.prepared !== true) throw new Error("后台未确认安全收尾，未停止系统常驻服务。")
        const latest = readDaemonRegistry()
        if (!latest || latest.pid !== registry.pid || latest.url !== registry.url || latest.token !== registry.token) throw new Error("常驻后台连接在准备期间发生变化，请重新连接后重试。")
        await this.reconcileDesktopService(registry)
        this.invalidateClient(); this.clientPromise = null
        return await this.getOrConnectClient()
      }
      const lease = await this.prepareShutdown(client, options.stopActive === true)
      // close() enters the application's closing state synchronously. Release the
      // maintenance lease only afterwards, since shutdown waits for this lease.
      const closing = this.dispose()
      lease.release()
      await closing
      return await this.getOrConnectClient()
    } finally { this.restarting = false }
  }

  async switchDataDirectory(directory: string, options: { stopActive?: boolean; storePath?: string } = {}): Promise<VykorClient> {
    if (this.restarting) throw new Error("后台服务正在重启或切换数据，请稍候。")
    this.restarting = true
    try {
      if (!isAbsolute(directory)) throw new Error("数据目录必须是完整路径。")
      const target = resolve(directory)
      const storePath = resolve(options.storePath ?? join(target, "session-runtime", "sessions.db"))
      const offset = relative(target, storePath)
      if (offset.startsWith("..") || isAbsolute(offset)) throw new Error("数据库必须位于所选数据目录内。")
      if (!existsSync(storePath)) throw new Error("请先恢复并校验目标数据库，再切换数据目录。")
      if (!this.embeddedServer) throw new Error("切换数据需要使用应用内置后台服务。请先关闭系统常驻服务并重新打开应用。")
      const previous = this.dataLocation
      const previousEnv = process.env.VYKOR_DATA_DIR
      const previousStore = this.embeddedServer.store.path
      const client = await this.getOrConnectClient()
      const lease = await this.prepareShutdown(client, options.stopActive === true)
      const closing = this.dispose()
      lease.release()
      await closing
      this.dataLocation = { directory: target, storePath }
      process.env.VYKOR_DATA_DIR = target
      try {
        const next = await this.getOrConnectClient()
        this.saveDataLocation()
        return next
      } catch (error) {
        await this.dispose()
        this.dataLocation = previous ?? (previousEnv ? { directory: previousEnv, storePath: previousStore } : null)
        if (previousEnv === undefined) delete process.env.VYKOR_DATA_DIR; else process.env.VYKOR_DATA_DIR = previousEnv
        await this.getOrConnectClient()
        throw new Error(`数据切换失败，已恢复原数据位置：${errorMessage(error)}`)
      }
    } finally { this.restarting = false }
  }

  private async prepareShutdown(client: VykorClient, stopActive: boolean) {
    const server = this.embeddedServer
    if (!server) throw new Error("系统常驻后台暂未提供原子安全重启接口。请先关闭系统常驻服务并重新打开应用，再使用内置后台重启。")
    if (stopActive) await this.stopActiveWork(client)
    const lease = server.application.control.acquireGlobalMutation()
    if (!lease) throw new Error("仍有任务运行或尚未安全收尾，请等待结束后重试。")
    try {
      const preview = await client.system.getRestartPreview()
      const terminals = await client.terminals.list()
      if (!Array.isArray(preview.runs) || !Array.isArray(preview.tasks) || !Array.isArray(preview.terminals)) throw new Error("后台未提供有效活动清单，无法安全重启。")
      if (preview.runs.length || preview.tasks.length || preview.terminals.length || terminals.some(terminal => ["pending", "running", "stopping"].includes(terminal.status))) {
        throw new Error("仍有运行或排队的任务、后台任务或终端，请等待它们安全收尾后重试。")
      }
      if (this.embeddedServer !== server) throw new Error("后台连接已变化，请重新读取后重试。")
      return lease
    } catch (error) { lease.release(); throw error }
  }

  private async stopActiveWork(client: VykorClient) {
    const preview = await client.system.getRestartPreview()
    const sessions = new Set([...preview.runs, ...preview.tasks].map(item => item.sessionId))
    for (const sessionId of sessions) await client.sessions.interrupt(sessionId)
    for (const terminal of await client.terminals.list()) {
      if (["pending", "running", "stopping"].includes(terminal.status)) await client.terminals.close(terminal.id)
    }
  }

  private saveDataLocation(): void {
    const target = this.dataLocationPath()
    const root = resolve(target, "..")
    mkdirSync(root, { recursive: true })
    const temporary = `${target}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: 1, location: this.dataLocation }), "utf8")
    renameSync(temporary, target)
  }

  async dispose(): Promise<void> {
    this.invalidateClient()
    const server = this.embeddedServer
    const embeddedUrl = this.embeddedUrl
    this.embeddedServer = null
    this.embeddedUrl = null
    this.clientPromise = null
    if (!server) return

    try {
      const registry = readDaemonRegistry()
      if (registry?.pid === process.pid && registry.url === embeddedUrl) clearDaemonRegistry()
    } catch {
      clearDaemonRegistry()
    }
    await server.close()
  }

  onInvalidated(listener: () => void): () => void {
    this.invalidationListeners.add(listener)
    return () => { this.invalidationListeners.delete(listener) }
  }

  private invalidateClient(): void {
    for (const listener of this.invalidationListeners) listener()
  }

  private async connect(): Promise<VykorClient> {
    let registry: DaemonRegistry | undefined
    try {
      this.setDaemonStatus("discovering", "正在查找 daemon")
      registry = readDaemonRegistry()
    } catch (error) {
      console.warn("[session] daemon registry is unreadable, starting embedded daemon", error)
      registry = undefined
    }

    let verified: VykorClient | undefined
    if (registry) {
      try {
        this.setDaemonStatus("connecting", "正在连接已运行的 daemon", { url: registry.url })
        const client = new VykorClient({ baseUrl: registry.url, token: registry.token })
        await this.verifyDaemon(client)
        verified = client
      } catch (error) {
        const detail = errorMessage(error)
        if (this.pidAlive(registry.pid)) {
          // The owner process is still alive: it may just be slow or briefly
          // unreachable. Never clear its registry entry or start a competing
          // daemon here — that would orphan a live owner and cause an
          // ApplicationOwnerConflictError on the next embedded start.
          this.setDaemonStatus("error", "已注册的 daemon 暂时不可达，请稍后重试", {
            url: registry.url,
            detail,
          })
          throw new Error(`Registered daemon (pid ${registry.pid}) is unreachable: ${detail}`)
        }
        console.warn("[session] registered daemon process is gone, starting embedded daemon", error)
        this.setDaemonStatus("starting", "已注册 daemon 已退出，正在启动内置 daemon", {
          detail,
        })
        clearDaemonRegistry()
      }
    }

    if (verified && registry) {
      if (isDesktopManagedRegistry(registry)) {
        this.setDaemonStatus("ready", "daemon 已连接", { url: registry.url })
        return verified
      }
      return await this.takeOverNonDesktopDaemon(registry)
    }

    return await this.startEmbeddedDaemon()
  }

  private async takeOverNonDesktopDaemon(registry: DaemonRegistry): Promise<VykorClient> {
    try {
      if (await this.shouldAutoStart()) {
        this.setDaemonStatus("starting", "正在将 daemon 切换为桌面托管服务", { url: registry.url })
        await this.reconcileDesktopService(registry)
        const next = readDaemonRegistry()
        if (!next || !isDesktopManagedRegistry(next)) {
          throw new Error("Desktop-managed daemon was not registered after service reconciliation")
        }
        this.setDaemonStatus("ready", "daemon 已连接", { url: next.url })
        return new VykorClient({ baseUrl: next.url, token: next.token })
      }
      this.setDaemonStatus("starting", "正在重启为桌面托管 daemon", { url: registry.url })
      await this.stopNonDesktopDaemon(registry)
      return await this.startEmbeddedDaemon()
    } catch (error) {
      this.setDaemonStatus("error", "daemon 桌面接管失败", {
        url: registry.url,
        detail: errorMessage(error),
      })
      throw error
    }
  }

  private async startEmbeddedDaemon(): Promise<VykorClient> {
    try {
      this.setDaemonStatus("starting", "正在启动内置 daemon")
      const token = createBearerToken()
      if (!this.dataLocation) {
        try {
          const saved = JSON.parse(readFileSync(this.dataLocationPath(), "utf8"))
          if (saved.version === 1 && saved.location && isAbsolute(saved.location.directory) && (!saved.location.storePath || isAbsolute(saved.location.storePath))) this.dataLocation = saved.location
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      }
      if (this.dataLocation) process.env.VYKOR_DATA_DIR = this.dataLocation.directory
      const { server, listen } = await startVykorDaemon({
        host: "127.0.0.1",
        port: 0,
        token,
        version: app.getVersion(),
        executionSurface: "desktop_managed",
        outsideProjectWorkspaceRoot: buildOutsideProjectRoot(app.getPath("documents")),
        ...(this.dataLocation?.storePath ? { storePath: this.dataLocation.storePath } : {}),
        ...(this.browserHost ? { browserHost: this.browserHost } : {}),
      })
      this.embeddedServer = server
      this.embeddedUrl = listen.url
      writeDaemonRegistry(
        createDaemonRegistryEntry({
          url: listen.url,
          pid: process.pid,
          token,
          storePath: server.store.path,
          version: app.getVersion(),
          executionSurface: "desktop_managed",
        })
      )
      this.setDaemonStatus("ready", "内置 daemon 已启动", { url: listen.url })
      return new VykorClient({ baseUrl: listen.url, token })
    } catch (error) {
      this.setDaemonStatus("error", "daemon 启动失败", { detail: errorMessage(error) })
      throw error
    }
  }

  private async verifyDaemon(client: VykorClient): Promise<void> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.verifyTimeoutMs)
    const timedOut = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error(`daemon verification timed out after ${this.verifyTimeoutMs}ms`)),
        { once: true }
      )
    })
    try {
      await Promise.race([
        (async () => {
          await client.protocol.health({ signal: controller.signal })
          await client.projects.list({ signal: controller.signal })
        })(),
        timedOut,
      ])
    } finally {
      clearTimeout(timeout)
    }
  }

  private setDaemonStatus(
    phase: DesktopDaemonStatusPhase,
    message: string,
    options: { detail?: string; url?: string } = {}
  ): void {
    this.daemonStatus = createDaemonStatus(phase, message, options)
    for (const window of BrowserWindow.getAllWindows()) {
      const webContents = window.webContents
      if (!webContents.isDestroyed()) {
        webContents.send(IpcEvents.sessionDaemonStatusChanged, this.daemonStatus)
      }
    }
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but we cannot signal it.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function createDaemonStatus(
  phase: DesktopDaemonStatusPhase,
  message: string,
  options: { detail?: string; url?: string } = {}
): DesktopDaemonStatus {
  return {
    phase,
    message,
    ...options,
    updatedAt: Date.now(),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
