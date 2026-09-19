import { app, BrowserWindow } from "electron"
import { OpenHarnessClient } from "@openharness/client"
import { type OpenHarnessHttpServer } from "@openharness/server"
import {
  clearDaemonRegistry,
  createBearerToken,
  readDaemonRegistry,
  startOpenHarnessDaemon,
  writeDaemonRegistry,
} from "@openharness/server/daemon-host"

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
  /** Process liveness check; injectable for tests. Defaults to `process.kill(pid, 0)`. */
  pidAlive?: (pid: number) => boolean
  /** How long to wait for a registered daemon to answer before giving up. */
  verifyTimeoutMs?: number
}

export class DaemonConnectionService {
  private clientPromise: Promise<OpenHarnessClient> | null = null
  private embeddedServer: OpenHarnessHttpServer | null = null
  private embeddedUrl: string | null = null
  private daemonStatus: DesktopDaemonStatus = createDaemonStatus("idle", "等待连接 daemon")
  private readonly pidAlive: (pid: number) => boolean
  private readonly verifyTimeoutMs: number

  constructor(options: DaemonConnectionServiceOptions = {}) {
    this.pidAlive = options.pidAlive ?? isPidAlive
    this.verifyTimeoutMs = options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS
  }

  getDaemonStatus(): DesktopDaemonStatus {
    return this.daemonStatus
  }

  getClient(): Promise<OpenHarnessClient> {
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

  refreshClient(): Promise<OpenHarnessClient> {
    this.clientPromise = null
    return this.getClient()
  }

  async dispose(): Promise<void> {
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

  private async connect(): Promise<OpenHarnessClient> {
    let registry: ReturnType<typeof readDaemonRegistry> = undefined
    try {
      this.setDaemonStatus("discovering", "正在查找 daemon")
      registry = readDaemonRegistry()
    } catch (error) {
      console.warn("[session] daemon registry is unreadable, starting embedded daemon", error)
      registry = undefined
    }

    if (registry) {
      try {
        this.setDaemonStatus("connecting", "正在连接已运行的 daemon", { url: registry.url })
        const client = new OpenHarnessClient({ baseUrl: registry.url, token: registry.token })
        await this.verifyDaemon(client)
        this.setDaemonStatus("ready", "daemon 已连接", { url: registry.url })
        return client
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

    return await this.startEmbeddedDaemon()
  }

  private async startEmbeddedDaemon(): Promise<OpenHarnessClient> {
    try {
      this.setDaemonStatus("starting", "正在启动内置 daemon")
      const token = createBearerToken()
      const { server, listen } = await startOpenHarnessDaemon({
        host: "127.0.0.1",
        port: 0,
        token,
        version: app.getVersion(),
        executionSurface: "desktop_managed",
        outsideProjectWorkspaceRoot: buildOutsideProjectRoot(app.getPath("documents")),
      })
      this.embeddedServer = server
      this.embeddedUrl = listen.url
      writeDaemonRegistry({
        url: listen.url,
        pid: process.pid,
        token,
        storePath: server.store.path,
        startedAt: Date.now(),
        version: app.getVersion(),
      })
      this.setDaemonStatus("ready", "内置 daemon 已启动", { url: listen.url })
      return new OpenHarnessClient({ baseUrl: listen.url, token })
    } catch (error) {
      this.setDaemonStatus("error", "daemon 启动失败", { detail: errorMessage(error) })
      throw error
    }
  }

  private async verifyDaemon(client: OpenHarnessClient): Promise<void> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.verifyTimeoutMs)
    const timedOut = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new Error(`daemon verification timed out after ${this.verifyTimeoutMs}ms`)),
        { once: true },
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
